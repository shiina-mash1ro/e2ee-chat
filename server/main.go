package main

import (
	"context"
	"crypto/hmac"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	mrand "math/rand"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/vmihailenco/msgpack/v5"
)

const (
	maxBodyBytes  = 50 * 1024 * 1024
	maxClients    = 100
	clientBufSize = 64
	pingInterval  = 25 * time.Second
	codeLimit     = 3
	codeWindow    = time.Minute
	powTTL        = 2 * time.Minute
)

var (
	roomIDRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{3,64}$`)
	clientIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,96}$`)
	codeRe     = regexp.MustCompile(`^(?:\d{4}|\d{6}|[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4,32})$`)
)

type Hub struct {
	mu            sync.RWMutex
	rooms         map[string]*Room
	codeLimiter   *RateLimiter
	trustedProxy  []*net.IPNet
	powSecret     []byte
	powDifficulty int
}

type Room struct {
	sseClients map[string]*Client
	wsClients  map[string]*Client
}

type Client struct {
	id     string
	events chan []byte
}

type wsEnvelope struct {
	Type       string `msgpack:"type" json:"type"`
	Room       string `msgpack:"room" json:"room"`
	From       string `msgpack:"from" json:"from"`
	To         string `msgpack:"to,omitempty" json:"to,omitempty"`
	Protocol   int    `msgpack:"protocol,omitempty" json:"protocol,omitempty"`
	MsgID      string `msgpack:"msg_id,omitempty" json:"msg_id,omitempty"`
	AckID      string `msgpack:"ack_id,omitempty" json:"ack_id,omitempty"`
	TransferID string `msgpack:"transfer_id,omitempty" json:"transfer_id,omitempty"`
	Seq        int    `msgpack:"seq,omitempty" json:"seq,omitempty"`
	Total      int    `msgpack:"total,omitempty" json:"total,omitempty"`
}

type RateLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	clients map[string]*rateBucket
}

type rateBucket struct {
	reset time.Time
	count int
}

type inboundEvent struct {
	Type string `json:"type"`
	Room string `json:"room"`
	From string `json:"from"`
	To   string `json:"to,omitempty"`
}

type codeRoomResponse struct {
	Code string `json:"code"`
	URL  string `json:"url"`
}

type codeJoinRequest struct {
	Code string   `json:"code"`
	Pow  powProof `json:"pow"`
}

type codeCreateRequest struct {
	Code string   `json:"code"`
	Pow  powProof `json:"pow"`
}

type powProof struct {
	Challenge string `json:"challenge"`
	Solution  string `json:"solution"`
}

type powChallengePayload struct {
	IP         string `json:"ip"`
	Purpose    string `json:"purpose"`
	Nonce      string `json:"nonce"`
	Difficulty int    `json:"difficulty"`
	ExpiresAt  int64  `json:"expires_at"`
}

type powChallengeResponse struct {
	Challenge  string `json:"challenge"`
	Difficulty int    `json:"difficulty"`
	ExpiresAt  int64  `json:"expires_at"`
}

func newRateLimiter(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{
		limit:   limit,
		window:  window,
		clients: make(map[string]*rateBucket),
	}
}

func (rl *RateLimiter) Allow(key string) (bool, time.Duration) {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	for ip, bucket := range rl.clients {
		if now.After(bucket.reset.Add(rl.window)) {
			delete(rl.clients, ip)
		}
	}

	bucket := rl.clients[key]
	if bucket == nil || now.After(bucket.reset) {
		rl.clients[key] = &rateBucket{reset: now.Add(rl.window), count: 1}
		return true, rl.window
	}
	if bucket.count >= rl.limit {
		return false, time.Until(bucket.reset)
	}
	bucket.count++
	return true, time.Until(bucket.reset)
}

func newHub() *Hub {
	secret := make([]byte, 32)
	if _, err := crand.Read(secret); err != nil {
		panic(err)
	}
	return &Hub{
		rooms:         make(map[string]*Room),
		codeLimiter:   newRateLimiter(codeLimit, codeWindow),
		trustedProxy:  parseCIDRList(os.Getenv("TRUSTED_PROXIES")),
		powSecret:     secret,
		powDifficulty: envInt("POW_DIFFICULTY", 12),
	}
}

func (h *Hub) addClient(roomID string, c *Client) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)
	if len(room.sseClients)+len(room.wsClients) >= maxClients {
		return errors.New("room is full")
	}
	if old := room.sseClients[c.id]; old != nil {
		close(old.events)
	}
	room.sseClients[c.id] = c
	return nil
}

func (h *Hub) removeClient(roomID, clientID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.rooms[roomID]
	if room == nil {
		return false
	}
	c := room.sseClients[clientID]
	if c == nil {
		return false
	}
	delete(room.sseClients, clientID)
	close(c.events)
	if len(room.sseClients)+len(room.wsClients) == 0 {
		delete(h.rooms, roomID)
	}
	return true
}

func (h *Hub) broadcast(roomID string, msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)

	var stale []string
	for id, c := range room.sseClients {
		select {
		case c.events <- msg:
		default:
			stale = append(stale, id)
		}
	}
	for _, id := range stale {
		close(room.sseClients[id].events)
		delete(room.sseClients, id)
	}
	if len(room.sseClients)+len(room.wsClients) == 0 {
		delete(h.rooms, roomID)
	}
}

func (h *Hub) roomLocked(roomID string) *Room {
	room := h.rooms[roomID]
	if room == nil {
		room = &Room{
			sseClients: make(map[string]*Client),
			wsClients:  make(map[string]*Client),
		}
		h.rooms[roomID] = room
	}
	if room.sseClients == nil {
		room.sseClients = make(map[string]*Client)
	}
	if room.wsClients == nil {
		room.wsClients = make(map[string]*Client)
	}
	return room
}

func (h *Hub) addWSClient(roomID string, c *Client) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)
	if len(room.sseClients)+len(room.wsClients) >= maxClients {
		return errors.New("room is full")
	}
	if old := room.wsClients[c.id]; old != nil {
		close(old.events)
	}
	room.wsClients[c.id] = c
	return nil
}

func (h *Hub) removeWSClient(roomID, clientID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.rooms[roomID]
	if room == nil {
		return false
	}
	c := room.wsClients[clientID]
	if c == nil {
		return false
	}
	delete(room.wsClients, clientID)
	close(c.events)
	if len(room.sseClients)+len(room.wsClients) == 0 {
		delete(h.rooms, roomID)
	}
	return true
}

func (h *Hub) broadcastWS(roomID string, msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)
	var stale []string
	for id, c := range room.wsClients {
		select {
		case c.events <- msg:
		default:
			stale = append(stale, id)
		}
	}
	for _, id := range stale {
		close(room.wsClients[id].events)
		delete(room.wsClients, id)
	}
	if len(room.sseClients)+len(room.wsClients) == 0 {
		delete(h.rooms, roomID)
	}
}

func main() {
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}

	hub := newHub()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/pow-challenge", hub.powChallengeHandler)
	mux.HandleFunc("/api/code-room", hub.codeRoomHandler)
	mux.HandleFunc("/api/rooms/", hub.apiHandler)
	mux.Handle("/assets/", http.FileServer(http.Dir("static")))
	mux.HandleFunc("/", pageHandler)

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func pageHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path != "/" {
		roomID, ok := strings.CutPrefix(r.URL.Path, "/r/")
		if !ok || !roomIDRe.MatchString(roomID) {
			http.NotFound(w, r)
			return
		}
	}
	http.ServeFile(w, r, "static/index.html")
}

func (h *Hub) codeRoomHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.createCodeRoom(w, r)
	case http.MethodPut:
		h.joinCodeRoom(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *Hub) powChallengeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	challenge, payload, err := h.newPowChallenge(h.clientIP(r), "code")
	if err != nil {
		http.Error(w, "challenge failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, powChallengeResponse{
		Challenge:  challenge,
		Difficulty: payload.Difficulty,
		ExpiresAt:  payload.ExpiresAt,
	})
}

func (h *Hub) createCodeRoom(w http.ResponseWriter, r *http.Request) {
	var req codeCreateRequest
	if err := readJSONBody(w, r, 4096, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !h.verifyCodeRequest(w, r, req.Pow) {
		return
	}
	code := normalizeCode(req.Code)
	if code == "" {
		code = randomCode(8)
	}
	if !codeRe.MatchString(code) {
		http.Error(w, "invalid code", http.StatusBadRequest)
		return
	}
	writeJSON(w, codeRoomResponse{Code: code, URL: "/r/" + code + "#p=" + code})
}

func (h *Hub) joinCodeRoom(w http.ResponseWriter, r *http.Request) {
	var req codeJoinRequest
	if err := readJSONBody(w, r, 4096, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	code := normalizeCode(req.Code)
	if !codeRe.MatchString(code) {
		http.Error(w, "invalid code", http.StatusBadRequest)
		return
	}
	if !h.verifyCodeRequest(w, r, req.Pow) {
		return
	}
	writeJSON(w, codeRoomResponse{Code: code, URL: "/r/" + code + "#p=" + code})
}

func (h *Hub) verifyCodeRequest(w http.ResponseWriter, r *http.Request, proof powProof) bool {
	ip := h.clientIP(r)
	if err := h.verifyPowProof(ip, "code", proof); err != nil {
		http.Error(w, "invalid pow: "+err.Error(), http.StatusBadRequest)
		return false
	}
	ok, retryAfter := h.codeLimiter.Allow(ip)
	if !ok {
		w.Header().Set("Retry-After", fmt.Sprintf("%.0f", retryAfter.Seconds()))
		http.Error(w, "too many code room requests", http.StatusTooManyRequests)
		return false
	}
	return true
}

func readJSONBody(w http.ResponseWriter, r *http.Request, limit int64, v any) error {
	defer r.Body.Close()
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		return errors.New("request body too large")
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return errors.New("empty json")
	}
	if err := json.Unmarshal(body, v); err != nil {
		return errors.New("invalid json")
	}
	return nil
}

func (h *Hub) apiHandler(w http.ResponseWriter, r *http.Request) {
	roomID, tail, ok := parseAPIRoute(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if !roomIDRe.MatchString(roomID) {
		http.Error(w, "invalid room id", http.StatusBadRequest)
		return
	}

	switch {
	case r.Method == http.MethodGet && tail == "events":
		h.eventsHandler(w, r, roomID)
	case r.Method == http.MethodGet && tail == "ws":
		h.wsHandler(w, r, roomID)
	case r.Method == http.MethodPost && tail == "messages":
		h.messagesHandler(w, r, roomID)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func parseAPIRoute(path string) (roomID string, tail string, ok bool) {
	rest, ok := strings.CutPrefix(path, "/api/rooms/")
	if !ok {
		return "", "", false
	}
	parts := strings.Split(rest, "/")
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func (h *Hub) eventsHandler(w http.ResponseWriter, r *http.Request, roomID string) {
	clientID := r.URL.Query().Get("client_id")
	if !clientIDRe.MatchString(clientID) {
		http.Error(w, "invalid client id", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	client := &Client{id: clientID, events: make(chan []byte, clientBufSize)}
	if err := h.addClient(roomID, client); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer func() {
		removed := h.removeClient(roomID, clientID)
		if removed {
			leave := fmt.Sprintf(`{"type":"peer_leave","room":%q,"from":%q}`, roomID, clientID)
			h.broadcast(roomID, []byte(leave))
		}
	}()

	headers := w.Header()
	headers.Set("Content-Type", "text/event-stream")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")

	ctx := r.Context()
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	writeSSE(w, "ping", []byte("{}"))
	flusher.Flush()

	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-client.events:
			if !ok {
				return
			}
			writeSSE(w, "message", msg)
			flusher.Flush()
		case <-ticker.C:
			writeSSE(w, "ping", []byte("{}"))
			flusher.Flush()
		}
	}
}

func (h *Hub) messagesHandler(w http.ResponseWriter, r *http.Request, roomID string) {
	defer r.Body.Close()

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	if !json.Valid(body) {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	var event inboundEvent
	if err := json.Unmarshal(body, &event); err != nil {
		http.Error(w, "invalid event", http.StatusBadRequest)
		return
	}
	if !validEventType(event.Type) {
		http.Error(w, "invalid event type", http.StatusBadRequest)
		return
	}
	if event.Room != "" && event.Room != roomID {
		http.Error(w, "room mismatch", http.StatusBadRequest)
		return
	}
	if event.From != "" && !clientIDRe.MatchString(event.From) {
		http.Error(w, "invalid sender", http.StatusBadRequest)
		return
	}
	if event.To != "" && !clientIDRe.MatchString(event.To) {
		http.Error(w, "invalid recipient", http.StatusBadRequest)
		return
	}

	h.broadcast(roomID, body)
	log.Printf("broadcast room=%s type=%s", roomID, event.Type)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Hub) wsHandler(w http.ResponseWriter, r *http.Request, roomID string) {
	clientID := r.URL.Query().Get("client_id")
	if !clientIDRe.MatchString(clientID) {
		http.Error(w, "invalid client id", http.StatusBadRequest)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		log.Printf("websocket accept failed: %v", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.SetReadLimit(maxBodyBytes)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	client := &Client{id: clientID, events: make(chan []byte, clientBufSize)}
	if err := h.addWSClient(roomID, client); err != nil {
		conn.Close(websocket.StatusTryAgainLater, err.Error())
		return
	}
	defer func() {
		removed := h.removeWSClient(roomID, clientID)
		if removed {
			leave := wsEnvelope{Type: "peer_leave", Room: roomID, From: clientID, Protocol: 2}
			if body, err := msgpack.Marshal(leave); err == nil {
				h.broadcastWS(roomID, body)
			}
		}
	}()

	welcome := wsEnvelope{Type: "welcome", Room: roomID, From: "server", Protocol: 2}
	if body, err := msgpack.Marshal(welcome); err == nil {
		client.events <- body
	}

	go h.readWS(ctx, cancel, conn, roomID, client)

	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-client.events:
			if !ok {
				return
			}
			if err := conn.Write(ctx, websocket.MessageBinary, msg); err != nil {
				cancel()
				return
			}
		case <-ticker.C:
			ping := wsEnvelope{Type: "ping", Room: roomID, From: "server", Protocol: 2}
			body, err := msgpack.Marshal(ping)
			if err != nil {
				continue
			}
			if err := conn.Write(ctx, websocket.MessageBinary, body); err != nil {
				cancel()
				return
			}
		}
	}
}

func (h *Hub) readWS(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, roomID string, client *Client) {
	defer cancel()
	for {
		messageType, body, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if messageType != websocket.MessageBinary {
			continue
		}

		var event wsEnvelope
		if err := msgpack.Unmarshal(body, &event); err != nil {
			enqueueWS(client, wsEnvelope{Type: "server_error", Room: roomID, From: "server", Protocol: 2})
			continue
		}
		if err := validateWSEvent(event, roomID, client.id); err != nil {
			enqueueWS(client, wsEnvelope{Type: "server_error", Room: roomID, From: "server", Protocol: 2, AckID: event.MsgID})
			continue
		}

		ackType := "server_ack"
		if event.Type == "chunk" {
			ackType = "chunk_ack"
		}
		if event.MsgID != "" {
			enqueueWS(client, wsEnvelope{Type: ackType, Room: roomID, From: "server", Protocol: 2, AckID: event.MsgID})
		}
		h.broadcastWS(roomID, body)
		log.Printf("ws broadcast room=%s type=%s", roomID, event.Type)
	}
}

func enqueueWS(client *Client, event wsEnvelope) {
	body, err := msgpack.Marshal(event)
	if err != nil {
		return
	}
	select {
	case client.events <- body:
	default:
	}
}

func validateWSEvent(event wsEnvelope, roomID, clientID string) error {
	if event.Protocol != 2 {
		return errors.New("invalid protocol")
	}
	if !validWSEventType(event.Type) {
		return errors.New("invalid event type")
	}
	if event.Room != "" && event.Room != roomID {
		return errors.New("room mismatch")
	}
	if event.From != "" && event.From != clientID {
		return errors.New("sender mismatch")
	}
	if event.From != "" && !clientIDRe.MatchString(event.From) {
		return errors.New("invalid sender")
	}
	if event.To != "" && !clientIDRe.MatchString(event.To) {
		return errors.New("invalid recipient")
	}
	if requiresMsgID(event.Type) && event.MsgID == "" {
		return errors.New("missing message id")
	}
	return nil
}

func validEventType(t string) bool {
	switch t {
	case "hello", "peer_hello", "group_msg", "private_msg", "recipient_ack":
		return true
	default:
		return false
	}
}

func validWSEventType(t string) bool {
	switch t {
	case "hello", "peer_hello", "group_msg", "private_msg", "recipient_ack", "chunk":
		return true
	default:
		return false
	}
}

func requiresMsgID(t string) bool {
	switch t {
	case "group_msg", "private_msg", "chunk":
		return true
	default:
		return false
	}
}

func writeSSE(w io.Writer, event string, data []byte) {
	fmt.Fprintf(w, "event: %s\n", event)
	fmt.Fprintf(w, "data: %s\n\n", data)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json failed: %v", err)
	}
}

func (h *Hub) newPowChallenge(ip, purpose string) (string, powChallengePayload, error) {
	nonce := make([]byte, 16)
	if _, err := crand.Read(nonce); err != nil {
		return "", powChallengePayload{}, err
	}
	payload := powChallengePayload{
		IP:         ip,
		Purpose:    purpose,
		Nonce:      base64.RawURLEncoding.EncodeToString(nonce),
		Difficulty: h.powDifficulty,
		ExpiresAt:  time.Now().Add(powTTL).Unix(),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", powChallengePayload{}, err
	}
	encodedBody := base64.RawURLEncoding.EncodeToString(body)
	sig := hmacSHA256(h.powSecret, []byte(encodedBody))
	encodedSig := base64.RawURLEncoding.EncodeToString(sig)
	return encodedBody + "." + encodedSig, payload, nil
}

func (h *Hub) verifyPowProof(ip, purpose string, proof powProof) error {
	if proof.Challenge == "" || proof.Solution == "" {
		return errors.New("missing proof")
	}
	parts := strings.Split(proof.Challenge, ".")
	if len(parts) != 2 {
		return errors.New("bad challenge")
	}
	expectedSig := hmacSHA256(h.powSecret, []byte(parts[0]))
	gotSig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(gotSig, expectedSig) {
		return errors.New("bad signature")
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return errors.New("bad payload")
	}
	var payload powChallengePayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return errors.New("bad payload")
	}
	if payload.IP != ip || payload.Purpose != purpose {
		return errors.New("wrong client")
	}
	if time.Now().Unix() > payload.ExpiresAt {
		return errors.New("expired")
	}
	if payload.Difficulty < 1 || payload.Difficulty > 30 {
		return errors.New("bad difficulty")
	}
	hash := sha256.Sum256([]byte(proof.Challenge + ":" + proof.Solution))
	if !hasLeadingZeroBits(hash[:], payload.Difficulty) {
		return errors.New("insufficient work")
	}
	return nil
}

func hmacSHA256(secret, body []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return mac.Sum(nil)
}

func hasLeadingZeroBits(hash []byte, bits int) bool {
	fullBytes := bits / 8
	remainingBits := bits % 8
	for i := 0; i < fullBytes; i++ {
		if i >= len(hash) || hash[i] != 0 {
			return false
		}
	}
	if remainingBits == 0 {
		return true
	}
	if fullBytes >= len(hash) {
		return false
	}
	mask := byte(0xff << (8 - remainingBits))
	return hash[fullBytes]&mask == 0
}

func (h *Hub) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remoteIP := net.ParseIP(host)
	if remoteIP == nil {
		return host
	}

	if h.isTrustedProxy(remoteIP) {
		if forwardedFor := r.Header.Get("X-Forwarded-For"); forwardedFor != "" {
			parts := strings.Split(forwardedFor, ",")
			if ip := net.ParseIP(strings.TrimSpace(parts[0])); ip != nil {
				return ip.String()
			}
		}
		if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
			if ip := net.ParseIP(strings.TrimSpace(realIP)); ip != nil {
				return ip.String()
			}
		}
	}

	return remoteIP.String()
}

func (h *Hub) isTrustedProxy(ip net.IP) bool {
	if len(h.trustedProxy) == 0 {
		return false
	}
	for _, network := range h.trustedProxy {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func parseCIDRList(value string) []*net.IPNet {
	var out []*net.IPNet
	for _, raw := range strings.Split(value, ",") {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		if strings.EqualFold(item, "cloudflare") {
			out = append(out, parseCIDRList(strings.Join(cloudflareCIDRs, ","))...)
			continue
		}
		if strings.Contains(item, "/") {
			if _, network, err := net.ParseCIDR(item); err == nil {
				out = append(out, network)
			}
			continue
		}
		if ip := net.ParseIP(item); ip != nil {
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
		}
	}
	return out
}

const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

func randomCode(length int) string {
	var b strings.Builder
	for b.Len() < length {
		b.WriteByte(codeAlphabet[mrand.Intn(len(codeAlphabet))])
	}
	return b.String()
}

func normalizeCode(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, " ", "")
	value = strings.ReplaceAll(value, "-", "")
	value = strings.ReplaceAll(value, "_", "")
	return value
}

var cloudflareCIDRs = []string{
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
}

func envInt(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func shutdownServer(ctx context.Context, server *http.Server) error {
	return server.Shutdown(ctx)
}
