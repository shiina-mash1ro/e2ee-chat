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
	maxBodyBytes       = 50 * 1024 * 1024
	defaultRoomClients = 4
	maxRoomClients     = 100
	clientBufSize      = 64
	pingInterval       = 25 * time.Second
	codeLimit          = 3
	codeWindow         = time.Minute
	powTTL             = 2 * time.Minute
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
	leaveGrace    time.Duration
}

type Room struct {
	sseClients  map[string]*Client
	wsClients   map[string]*Client
	purgeTimers map[string]*time.Timer
	purgeEpochs map[string]uint64
	maxClients  int
	configured  bool
}

type Client struct {
	id     string
	token  string
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
	MessageType string `msgpack:"message_type,omitempty" json:"message_type,omitempty"`
	Features    []string `msgpack:"features,omitempty" json:"features,omitempty"`
	Seq        int    `msgpack:"seq,omitempty" json:"seq,omitempty"`
	Total      int    `msgpack:"total,omitempty" json:"total,omitempty"`
	Epoch          int    `msgpack:"epoch,omitempty" json:"epoch,omitempty"`
	NextEpoch      int    `msgpack:"next_epoch,omitempty" json:"next_epoch,omitempty"`
	SenderKeyID    string `msgpack:"sender_key_id,omitempty" json:"sender_key_id,omitempty"`
	RecipientKeyID string `msgpack:"recipient_key_id,omitempty" json:"recipient_key_id,omitempty"`
	RotationID     string `msgpack:"rotation_id,omitempty" json:"rotation_id,omitempty"`
	PublicKey      []byte `msgpack:"public_key,omitempty" json:"public_key,omitempty"`
	SignPublicKey  []byte `msgpack:"sign_public_key,omitempty" json:"sign_public_key,omitempty"`
	HelloMAC       []byte `msgpack:"hello_mac,omitempty" json:"hello_mac,omitempty"`
	Signature      []byte `msgpack:"signature,omitempty" json:"signature,omitempty"`
	Nonce          []byte `msgpack:"nonce,omitempty" json:"nonce,omitempty"`
	Ciphertext     []byte `msgpack:"ciphertext,omitempty" json:"ciphertext,omitempty"`
	RosterHash     []byte `msgpack:"roster_hash,omitempty" json:"roster_hash,omitempty"`
	SealedKey      []byte `msgpack:"sealed_key,omitempty" json:"sealed_key,omitempty"`
	DisplayName    string `msgpack:"display_name,omitempty" json:"display_name,omitempty"`
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
	Type           string `json:"type"`
	Room           string `json:"room"`
	From           string `json:"from"`
	To             string `json:"to,omitempty"`
	Protocol       int    `json:"protocol"`
	MsgID          string `json:"msg_id,omitempty"`
	AckID          string `json:"ack_id,omitempty"`
	TransferID     string `json:"transfer_id,omitempty"`
	MessageType    string `json:"message_type,omitempty"`
	Features       []string `json:"features,omitempty"`
	Seq            int    `json:"seq,omitempty"`
	Total          int    `json:"total,omitempty"`
	Epoch          int    `json:"epoch,omitempty"`
	NextEpoch      int    `json:"next_epoch,omitempty"`
	SenderKeyID    string `json:"sender_key_id,omitempty"`
	RecipientKeyID string `json:"recipient_key_id,omitempty"`
	RotationID     string `json:"rotation_id,omitempty"`
	PublicKey      string `json:"public_key,omitempty"`
	SignPublicKey  string `json:"sign_public_key,omitempty"`
	HelloMAC       string `json:"hello_mac,omitempty"`
	Signature      string `json:"signature,omitempty"`
	Nonce          string `json:"nonce,omitempty"`
	Ciphertext     string `json:"ciphertext,omitempty"`
	RosterHash     string `json:"roster_hash,omitempty"`
	SealedKey      string `json:"sealed_key,omitempty"`
	DisplayName    string `json:"display_name,omitempty"`
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
	Code       string   `json:"code"`
	MaxClients int      `json:"max_clients"`
	Pow        powProof `json:"pow"`
}

type roomConfigRequest struct {
	MaxClients int `json:"max_clients"`
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
		leaveGrace:    30 * time.Second,
	}
}

func (h *Hub) addClient(roomID string, c *Client) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)
	if roomAtCapacityLocked(room, c.id) {
		return errors.New("room is full")
	}
	h.cancelPurgeLocked(room, c.id)
	if old := room.sseClients[c.id]; old != nil {
		close(old.events)
	}
	room.sseClients[c.id] = c
	return nil
}

func (h *Hub) removeClient(roomID string, client *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.rooms[roomID]
	if room == nil {
		return false
	}
	if room.sseClients[client.id] != client {
		return false
	}
	delete(room.sseClients, client.id)
	close(client.events)
	h.schedulePurgeLocked(roomID, room, client.id)
	return true
}

func (h *Hub) broadcast(roomID string, msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)
	h.broadcastToSSELocked(room, nil, msg)
	if len(room.sseClients)+len(room.wsClients) == 0 && len(room.purgeTimers) == 0 {
		delete(h.rooms, roomID)
	}
}

func (h *Hub) roomLocked(roomID string) *Room {
	room := h.rooms[roomID]
	if room == nil {
		room = &Room{
			sseClients:  make(map[string]*Client),
			wsClients:   make(map[string]*Client),
			purgeTimers: make(map[string]*time.Timer),
			purgeEpochs: make(map[string]uint64),
			maxClients:  defaultRoomClients,
		}
		h.rooms[roomID] = room
	}
	if room.sseClients == nil {
		room.sseClients = make(map[string]*Client)
	}
	if room.wsClients == nil {
		room.wsClients = make(map[string]*Client)
	}
	if room.purgeTimers == nil {
		room.purgeTimers = make(map[string]*time.Timer)
	}
	if room.purgeEpochs == nil {
		room.purgeEpochs = make(map[string]uint64)
	}
	if room.maxClients == 0 {
		room.maxClients = defaultRoomClients
	}
	return room
}

func (h *Hub) addWSClient(roomID string, c *Client) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)
	if roomAtCapacityLocked(room, c.id) {
		return errors.New("room is full")
	}
	h.cancelPurgeLocked(room, c.id)
	if old := room.wsClients[c.id]; old != nil {
		close(old.events)
	}
	room.wsClients[c.id] = c
	return nil
}

func roomAtCapacityLocked(room *Room, clientID string) bool {
	if room.sseClients[clientID] != nil || room.wsClients[clientID] != nil {
		return false
	}
	ids := make(map[string]struct{}, len(room.sseClients)+len(room.wsClients))
	for id := range room.sseClients {
		ids[id] = struct{}{}
	}
	for id := range room.wsClients {
		ids[id] = struct{}{}
	}
	return len(ids) >= room.maxClients
}

func validRoomMaxClients(value int) bool {
	return value >= 2 && value <= maxRoomClients
}

func normalizedRoomMaxClients(value int) int {
	if value == 0 {
		return defaultRoomClients
	}
	return value
}

func (h *Hub) configureRoom(roomID string, maxClients int) error {
	if !validRoomMaxClients(maxClients) {
		return errors.New("max clients must be between 2 and 100")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.roomLocked(roomID)
	if room.configured || len(room.sseClients)+len(room.wsClients) > 0 {
		return errors.New("room is already configured")
	}
	room.maxClients = maxClients
	room.configured = true
	return nil
}

func (h *Hub) removeWSClient(roomID string, client *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.rooms[roomID]
	if room == nil {
		return false
	}
	if room.wsClients[client.id] != client {
		return false
	}
	delete(room.wsClients, client.id)
	close(client.events)
	h.schedulePurgeLocked(roomID, room, client.id)
	return true
}

func (h *Hub) cancelPurgeLocked(room *Room, clientID string) {
	room.purgeEpochs[clientID]++
	if timer := room.purgeTimers[clientID]; timer != nil {
		timer.Stop()
		delete(room.purgeTimers, clientID)
	}
}

func (h *Hub) schedulePurgeLocked(roomID string, room *Room, clientID string) {
	if room.sseClients[clientID] != nil || room.wsClients[clientID] != nil {
		return
	}
	room.purgeEpochs[clientID]++
	epoch := room.purgeEpochs[clientID]
	if timer := room.purgeTimers[clientID]; timer != nil {
		timer.Stop()
	}
	room.purgeTimers[clientID] = time.AfterFunc(h.leaveGrace, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		current := h.rooms[roomID]
		if current == nil || current.purgeEpochs[clientID] != epoch || current.sseClients[clientID] != nil || current.wsClients[clientID] != nil {
			return
		}
		delete(current.purgeTimers, clientID)
		h.broadcastPeerPurgeLocked(roomID, current, clientID)
		if len(current.sseClients)+len(current.wsClients) == 0 && len(current.purgeTimers) == 0 {
			delete(h.rooms, roomID)
		}
	})
}

func (h *Hub) broadcastPeerPurgeLocked(roomID string, room *Room, clientID string) {
	jsonBody := []byte(fmt.Sprintf(`{"type":"peer_purge","room":%q,"from":%q,"protocol":3}`, roomID, clientID))
	h.broadcastToSSELocked(room, nil, jsonBody)
	wsBody, err := msgpack.Marshal(wsEnvelope{Type: "peer_purge", Room: roomID, From: clientID, Protocol: 3})
	if err == nil {
		h.broadcastToWSLocked(room, nil, wsBody)
	}
}

func (h *Hub) explicitAction(roomID, clientID, token string, wsClient *Client, leave bool) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.rooms[roomID]
	if room == nil {
		return false
	}
	client := wsClient
	if client == nil {
		client = room.sseClients[clientID]
		if client == nil || client.token == "" || client.token != token {
			return false
		}
	} else if room.wsClients[clientID] != client {
		return false
	}
	h.cancelPurgeLocked(room, clientID)
	h.broadcastPeerPurgeLocked(roomID, room, clientID)
	if leave {
		if wsClient == nil {
			delete(room.sseClients, clientID)
		} else {
			delete(room.wsClients, clientID)
		}
		close(client.events)
		jsonLeave := []byte(fmt.Sprintf(`{"type":"peer_leave","room":%q,"from":%q,"protocol":3}`, roomID, clientID))
		h.broadcastToSSELocked(room, nil, jsonLeave)
		wsLeave, err := msgpack.Marshal(wsEnvelope{Type: "peer_leave", Room: roomID, From: clientID, Protocol: 3})
		if err == nil {
			h.broadcastToWSLocked(room, nil, wsLeave)
		}
		if len(room.sseClients)+len(room.wsClients) == 0 && len(room.purgeTimers) == 0 {
			delete(h.rooms, roomID)
		}
	}
	return true
}

func (h *Hub) clientOnline(roomID, clientID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room := h.rooms[roomID]
	return room != nil && (room.sseClients[clientID] != nil || room.wsClients[clientID] != nil)
}

func (h *Hub) broadcastWS(roomID string, msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)
	h.broadcastToWSLocked(room, nil, msg)
	if len(room.sseClients)+len(room.wsClients) == 0 && len(room.purgeTimers) == 0 {
		delete(h.rooms, roomID)
	}
}

func (h *Hub) dispatchSSE(roomID string, event inboundEvent, msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)
	targets := eventTargets(event.Type, event.From, event.To)
	h.broadcastToSSELocked(room, targets, msg)
	if wsEvent, err := event.toWS(); err == nil {
		if wsBody, err := msgpack.Marshal(wsEvent); err == nil {
			h.broadcastToWSLocked(room, targets, wsBody)
		}
	}
	if len(room.sseClients)+len(room.wsClients) == 0 && len(room.purgeTimers) == 0 {
		delete(h.rooms, roomID)
	}
}

func (h *Hub) dispatchWS(roomID string, event wsEnvelope, msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room := h.roomLocked(roomID)
	targets := eventTargets(event.Type, event.From, event.To)
	h.broadcastToWSLocked(room, targets, msg)
	if sseEvent := event.toSSE(); sseEvent != nil {
		if sseBody, err := json.Marshal(sseEvent); err == nil {
			h.broadcastToSSELocked(room, targets, sseBody)
		}
	}
	if len(room.sseClients)+len(room.wsClients) == 0 && len(room.purgeTimers) == 0 {
		delete(h.rooms, roomID)
	}
}

func (e inboundEvent) toWS() (wsEnvelope, error) {
	decode := func(value string) ([]byte, error) {
		if value == "" { return nil, nil }
		return base64.StdEncoding.DecodeString(value)
	}
	publicKey, err := decode(e.PublicKey); if err != nil { return wsEnvelope{}, err }
	signPublicKey, err := decode(e.SignPublicKey); if err != nil { return wsEnvelope{}, err }
	helloMAC, err := decode(e.HelloMAC); if err != nil { return wsEnvelope{}, err }
	signature, err := decode(e.Signature); if err != nil { return wsEnvelope{}, err }
	nonce, err := decode(e.Nonce); if err != nil { return wsEnvelope{}, err }
	ciphertext, err := decode(e.Ciphertext); if err != nil { return wsEnvelope{}, err }
	rosterHash, err := decode(e.RosterHash); if err != nil { return wsEnvelope{}, err }
	sealedKey, err := decode(e.SealedKey); if err != nil { return wsEnvelope{}, err }
	return wsEnvelope{Type:e.Type, Room:e.Room, From:e.From, To:e.To, Protocol:e.Protocol, MsgID:e.MsgID, AckID:e.AckID, TransferID:e.TransferID, MessageType:e.MessageType, Features:e.Features, Seq:e.Seq, Total:e.Total, Epoch:e.Epoch, NextEpoch:e.NextEpoch, SenderKeyID:e.SenderKeyID, RecipientKeyID:e.RecipientKeyID, RotationID:e.RotationID, PublicKey:publicKey, SignPublicKey:signPublicKey, HelloMAC:helloMAC, Signature:signature, Nonce:nonce, Ciphertext:ciphertext, RosterHash:rosterHash, SealedKey:sealedKey, DisplayName:e.DisplayName}, nil
}

func (e wsEnvelope) toSSE() map[string]any {
	result := map[string]any{"type":e.Type, "room":e.Room, "from":e.From, "protocol":e.Protocol}
	put := func(key string, value any, present bool) { if present { result[key] = value } }
	put("to", e.To, e.To != ""); put("msg_id", e.MsgID, e.MsgID != ""); put("ack_id", e.AckID, e.AckID != ""); put("transfer_id", e.TransferID, e.TransferID != ""); put("message_type", e.MessageType, e.MessageType != "")
	put("features", e.Features, len(e.Features)>0); put("seq", e.Seq, e.Seq != 0); put("total", e.Total, e.Total != 0); put("epoch", e.Epoch, true); put("next_epoch", e.NextEpoch, e.NextEpoch != 0)
	put("sender_key_id", e.SenderKeyID, e.SenderKeyID != ""); put("recipient_key_id", e.RecipientKeyID, e.RecipientKeyID != ""); put("rotation_id", e.RotationID, e.RotationID != ""); put("display_name", e.DisplayName, e.DisplayName != "")
	binary := map[string][]byte{"public_key":e.PublicKey, "sign_public_key":e.SignPublicKey, "hello_mac":e.HelloMAC, "signature":e.Signature, "nonce":e.Nonce, "ciphertext":e.Ciphertext, "roster_hash":e.RosterHash, "sealed_key":e.SealedKey}
	for key, value := range binary { if len(value)>0 { result[key] = base64.StdEncoding.EncodeToString(value) } }
	return result
}

func (h *Hub) broadcastToSSELocked(room *Room, targets map[string]struct{}, msg []byte) {
	var stale []string
	for id, c := range room.sseClients {
		if !targetAllowed(targets, id) {
			continue
		}
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
}

func (h *Hub) broadcastToWSLocked(room *Room, targets map[string]struct{}, msg []byte) {
	var stale []string
	for id, c := range room.wsClients {
		if !targetAllowed(targets, id) {
			continue
		}
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
}

func eventTargets(eventType, from, to string) map[string]struct{} {
	switch eventType {
	case "private_msg", "recipient_ack", "chunk", "key_offer", "key_ready", "join_key_offer", "join_key_ready", "device_key_update":
	default:
		return nil
	}
	if to == "" {
		return nil
	}
	targets := map[string]struct{}{to: {}}
	if from != "" {
		targets[from] = struct{}{}
	}
	return targets
}

func targetAllowed(targets map[string]struct{}, id string) bool {
	if targets == nil {
		return true
	}
	_, ok := targets[id]
	return ok
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
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
			w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
		}
		next.ServeHTTP(w, r)
	})
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
	maxClients := normalizedRoomMaxClients(req.MaxClients)
	if err := h.configureRoom(code, maxClients); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
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
	case r.Method == http.MethodPost && tail == "config":
		h.roomConfigHandler(w, r, roomID)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *Hub) roomConfigHandler(w http.ResponseWriter, r *http.Request, roomID string) {
	var req roomConfigRequest
	if err := readJSONBody(w, r, 1024, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := h.configureRoom(roomID, normalizedRoomMaxClients(req.MaxClients)); err != nil {
		status := http.StatusBadRequest
		if err.Error() == "room is already configured" {
			status = http.StatusConflict
		}
		http.Error(w, err.Error(), status)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
	connectionToken := r.URL.Query().Get("connection_token")
	if !clientIDRe.MatchString(clientID) {
		http.Error(w, "invalid client id", http.StatusBadRequest)
		return
	}
	if !clientIDRe.MatchString(connectionToken) {
		http.Error(w, "invalid connection token", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	client := &Client{id: clientID, token: connectionToken, events: make(chan []byte, clientBufSize)}
	if err := h.addClient(roomID, client); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer func() {
		removed := h.removeClient(roomID, client)
		if removed && !h.clientOnline(roomID, clientID) {
			leave := fmt.Sprintf(`{"type":"peer_leave","room":%q,"from":%q,"protocol":3}`, roomID, clientID)
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
	if err := validateSSEEvent(event); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if event.Type == "purge_self" || event.Type == "leave_room" {
		connectionToken := r.Header.Get("X-Connection-Token")
		if event.From == "" || !h.explicitAction(roomID, event.From, connectionToken, nil, event.Type == "leave_room") {
			http.Error(w, "unauthorized sender", http.StatusUnauthorized)
			return
		}
		log.Printf("dispatch room=%s type=%s", roomID, event.Type)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	h.dispatchSSE(roomID, event, body)
	log.Printf("dispatch room=%s type=%s", roomID, event.Type)
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
		removed := h.removeWSClient(roomID, client)
		if removed && !h.clientOnline(roomID, clientID) {
			leave := wsEnvelope{Type: "peer_leave", Room: roomID, From: clientID, Protocol: 3}
			if body, err := msgpack.Marshal(leave); err == nil {
				h.broadcastWS(roomID, body)
			}
		}
	}()

	welcome := wsEnvelope{Type: "welcome", Room: roomID, From: "server", Protocol: 3}
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
			ping := wsEnvelope{Type: "ping", Room: roomID, From: "server", Protocol: 3}
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
			enqueueWS(client, wsEnvelope{Type: "server_error", Room: roomID, From: "server", Protocol: 3})
			continue
		}
		if err := validateWSEvent(event, roomID, client.id); err != nil {
			enqueueWS(client, wsEnvelope{Type: "server_error", Room: roomID, From: "server", Protocol: 3, AckID: event.MsgID})
			continue
		}
		if event.Type == "purge_self" || event.Type == "leave_room" {
			if !h.explicitAction(roomID, client.id, "", client, event.Type == "leave_room") {
				enqueueWS(client, wsEnvelope{Type: "server_error", Room: roomID, From: "server", Protocol: 3})
			}
			if event.Type == "leave_room" {
				return
			}
			continue
		}

		ackType := "server_ack"
		if event.Type == "chunk" {
			ackType = "chunk_ack"
		}
		if event.MsgID != "" {
			enqueueWS(client, wsEnvelope{Type: ackType, Room: roomID, From: "server", Protocol: 3, AckID: event.MsgID})
		}
		h.dispatchWS(roomID, event, body)
		log.Printf("ws dispatch room=%s type=%s", roomID, event.Type)
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
	if event.Protocol != 3 {
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
	if len(event.MsgID) > 160 || len(event.AckID) > 160 || len(event.TransferID) > 160 || len(event.RotationID) > 160 || len(event.SenderKeyID) > 96 || len(event.RecipientKeyID) > 96 {
		return errors.New("event identifier too long")
	}
	if event.Type == "hello" || event.Type == "peer_hello" {
		if len(event.PublicKey) != 32 || len(event.SignPublicKey) != 32 || len(event.HelloMAC) != 32 || len(event.Signature) != 64 || event.SenderKeyID == "" {
			return errors.New("invalid authenticated hello")
		}
	} else if requiresSignature(event.Type) && len(event.Signature) != 64 {
		return errors.New("missing or invalid signature")
	}
	if len(event.Nonce) > 32 || len(event.RosterHash) > 64 || len(event.SealedKey) > 256 {
		return errors.New("binary field too large")
	}
	if len(event.PublicKey) > 32 || len(event.SignPublicKey) > 32 || len(event.HelloMAC) > 32 || len(event.Signature) > 64 || len(event.Ciphertext) > maxBodyBytes {
		return errors.New("binary field too large")
	}
	if event.Type == "chunk" && (event.Total <= 0 || event.Total > 4096 || event.Seq < 0 || event.Seq >= event.Total) {
		return errors.New("invalid chunk range")
	}
	return nil
}

func validateSSEEvent(event inboundEvent) error {
	if event.Protocol != 3 {
		return errors.New("invalid protocol")
	}
	if !validEventType(event.Type) {
		return errors.New("invalid event type")
	}
	if requiresMsgID(event.Type) && event.MsgID == "" {
		return errors.New("missing message id")
	}
	if len(event.MsgID) > 160 || len(event.AckID) > 160 || len(event.TransferID) > 160 || len(event.RotationID) > 160 || len(event.SenderKeyID) > 96 || len(event.RecipientKeyID) > 96 {
		return errors.New("event identifier too long")
	}
	if event.Type == "hello" || event.Type == "peer_hello" {
		if !validBase64Bytes(event.PublicKey, 32) || !validBase64Bytes(event.SignPublicKey, 32) || !validBase64Bytes(event.HelloMAC, 32) || !validBase64Bytes(event.Signature, 64) || event.SenderKeyID == "" {
			return errors.New("invalid authenticated hello")
		}
	} else if requiresSignature(event.Type) && !validBase64Bytes(event.Signature, 64) {
		return errors.New("missing or invalid signature")
	}
	if !validOptionalBase64(event.Nonce, 32) || !validOptionalBase64(event.RosterHash, 64) || !validOptionalBase64(event.SealedKey, 256) {
		return errors.New("invalid binary field")
	}
	if !validOptionalBase64(event.Ciphertext, maxBodyBytes) {
		return errors.New("invalid ciphertext")
	}
	if event.Type == "chunk" && (event.Total <= 0 || event.Total > 4096 || event.Seq < 0 || event.Seq >= event.Total) {
		return errors.New("invalid chunk range")
	}
	return nil
}

func validBase64Bytes(value string, size int) bool {
	decoded, err := base64.StdEncoding.DecodeString(value)
	return err == nil && len(decoded) == size
}

func validOptionalBase64(value string, maxSize int) bool {
	if value == "" {
		return true
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	return err == nil && len(decoded) <= maxSize
}

func validEventType(t string) bool {
	switch t {
	case "hello", "peer_hello", "group_msg", "private_msg", "recipient_ack", "purge_self", "leave_room", "key_prepare", "key_offer", "key_ready", "key_commit", "key_abort", "join_key_offer", "join_key_ready", "device_key_update":
		return true
	default:
		return false
	}
}

func validWSEventType(t string) bool {
	switch t {
	case "hello", "peer_hello", "group_msg", "private_msg", "recipient_ack", "chunk", "purge_self", "leave_room", "key_prepare", "key_offer", "key_ready", "key_commit", "key_abort", "join_key_offer", "join_key_ready", "device_key_update":
		return true
	default:
		return false
	}
}

func requiresSignature(t string) bool {
	switch t {
	case "group_msg", "private_msg", "recipient_ack", "chunk", "purge_self", "leave_room", "key_prepare", "key_offer", "key_ready", "key_commit", "key_abort", "join_key_offer", "join_key_ready", "device_key_update":
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
