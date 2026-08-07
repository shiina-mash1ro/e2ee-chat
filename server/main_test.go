package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/vmihailenco/msgpack/v5"
)

func TestSecurityHeadersOwnedByApplication(t *testing.T) {
	handler := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") {
		t.Fatalf("CSP = %q, want frame-ancestors 'none'", got)
	}
	for name, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
	} {
		if got := rec.Header().Get(name); got != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unexpected broad CORS header %q", got)
	}
	if got := rec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("application emitted edge-owned HSTS header %q", got)
	}
}

func TestExtensionCORSRequiresExactConfiguredOrigin(t *testing.T) {
	handler := extensionCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), "chrome-extension://abcdefghijklmnop, https://ignored.example")
	for _, test := range []struct{ origin, want string }{
		{"chrome-extension://abcdefghijklmnop", "chrome-extension://abcdefghijklmnop"},
		{"chrome-extension://other", ""},
		{"https://ignored.example", ""},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/pow-challenge", nil)
		req.Header.Set("Origin", test.origin)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != test.want {
			t.Fatalf("origin %q allowed as %q, want %q", test.origin, got, test.want)
		}
	}
}

func TestWebSocketOriginRequiresSameSiteOrConfiguredExtension(t *testing.T) {
	for _, test := range []struct {
		origin     string
		configured string
		want       bool
	}{
		{"https://chat.example", "", true},
		{"https://evil.example", "", false},
		{"chrome-extension://abcdefghijklmnop", "chrome-extension://abcdefghijklmnop", true},
		{"chrome-extension://other", "chrome-extension://abcdefghijklmnop", false},
	} {
		req := httptest.NewRequest(http.MethodGet, "https://chat.example/api/rooms/testroom/ws", nil)
		req.Host = "chat.example"
		req.Header.Set("Origin", test.origin)
		if got := webSocketOriginAllowed(req, test.configured); got != test.want {
			t.Fatalf("origin %q allowed = %v, want %v", test.origin, got, test.want)
		}
	}
}

func TestExtensionInfoIdentifiesCompatibleService(t *testing.T) {
	handler := securityHeaders(http.HandlerFunc(extensionInfoHandler))
	req := httptest.NewRequest(http.MethodGet, "/api/extension-info", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var info struct {
		App          string `json:"app"`
		ExtensionAPI int    `json:"extensionApi"`
		Protocol     int    `json:"protocol"`
		Build        string `json:"build"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.App != "e2ee-chat" || info.ExtensionAPI != 1 || info.Protocol != protocolVersion || info.Build == "" {
		t.Fatalf("unexpected extension info: %+v", info)
	}

	post := httptest.NewRecorder()
	extensionInfoHandler(post, httptest.NewRequest(http.MethodPost, "/api/extension-info", nil))
	if post.Code != http.StatusMethodNotAllowed || post.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("POST status/allow = %d/%q", post.Code, post.Header().Get("Allow"))
	}
}

func TestCodeRoomRateLimitByRemoteIP(t *testing.T) {
	h := newHub()
	h.powDifficulty = 8
	for i := 0; i < codeLimit; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/code-room", strings.NewReader(`{"pow":`+mustProofJSON(t, h, "203.0.113.10")+`}`))
		req.RemoteAddr = "203.0.113.10:12345"
		rec := httptest.NewRecorder()
		h.codeRoomHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200", i+1, rec.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/api/code-room", strings.NewReader(`{"pow":`+mustProofJSON(t, h, "203.0.113.10")+`}`))
	req.RemoteAddr = "203.0.113.10:12345"
	rec := httptest.NewRecorder()
	h.codeRoomHandler(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("limited status = %d, want 429", rec.Code)
	}
}

func TestCodeRoomRateLimitIgnoresSpoofedForwardedFor(t *testing.T) {
	h := newHub()
	h.powDifficulty = 8
	for i := 0; i < codeLimit; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/code-room", strings.NewReader(`{"pow":`+mustProofJSON(t, h, "203.0.113.10")+`}`))
		req.RemoteAddr = "203.0.113.10:12345"
		req.Header.Set("X-Forwarded-For", "198.51.100.1")
		rec := httptest.NewRecorder()
		h.codeRoomHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200", i+1, rec.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/api/code-room", strings.NewReader(`{"pow":`+mustProofJSON(t, h, "203.0.113.10")+`}`))
	req.RemoteAddr = "203.0.113.10:12345"
	req.Header.Set("X-Forwarded-For", "198.51.100.2")
	rec := httptest.NewRecorder()
	h.codeRoomHandler(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("spoofed forwarded-for status = %d, want 429", rec.Code)
	}
}

func TestCodeRoomRateLimitUsesForwardedForFromTrustedProxy(t *testing.T) {
	h := newHub()
	h.powDifficulty = 8
	h.trustedProxy = parseCIDRList("10.0.0.0/8")

	for i := 0; i < codeLimit; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/code-room", strings.NewReader(`{"pow":`+mustProofJSON(t, h, "198.51.100.1")+`}`))
		req.RemoteAddr = "10.0.0.5:12345"
		req.Header.Set("X-Forwarded-For", "198.51.100.1")
		rec := httptest.NewRecorder()
		h.codeRoomHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200", i+1, rec.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPost, "/api/code-room", strings.NewReader(`{"pow":`+mustProofJSON(t, h, "198.51.100.2")+`}`))
	req.RemoteAddr = "10.0.0.5:12345"
	req.Header.Set("X-Forwarded-For", "198.51.100.2")
	rec := httptest.NewRecorder()
	h.codeRoomHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("different forwarded client status = %d, want 200", rec.Code)
	}
}

func TestJoinCodeRoomRateLimited(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "123456")
	h.powDifficulty = 8
	for i := 0; i < codeLimit; i++ {
		req := httptest.NewRequest(http.MethodPut, "/api/code-room", strings.NewReader(`{"code":"123456","pow":`+mustProofJSON(t, h, "203.0.113.20")+`}`))
		req.RemoteAddr = "203.0.113.20:12345"
		rec := httptest.NewRecorder()
		h.codeRoomHandler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("join request %d status = %d, want 200", i+1, rec.Code)
		}
	}

	req := httptest.NewRequest(http.MethodPut, "/api/code-room", strings.NewReader(`{"code":"123456","pow":`+mustProofJSON(t, h, "203.0.113.20")+`}`))
	req.RemoteAddr = "203.0.113.20:12345"
	rec := httptest.NewRecorder()
	h.codeRoomHandler(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("join limited status = %d, want 429", rec.Code)
	}
}

func TestJoinCodeRoomAcceptsCustomCode(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "TEAMR29")
	h.powDifficulty = 8
	req := httptest.NewRequest(http.MethodPut, "/api/code-room", strings.NewReader(`{"code":"team-r29","pow":`+mustProofJSON(t, h, "203.0.113.30")+`}`))
	req.RemoteAddr = "203.0.113.30:12345"
	rec := httptest.NewRecorder()
	h.codeRoomHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("custom code status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "/r/TEAMR29#p=TEAMR29") {
		t.Fatalf("custom code response did not normalize code: %s", rec.Body.String())
	}
}

func TestJoinCodeRoomAcceptsPreviouslyAmbiguousCode(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "ROOM01IL")
	h.powDifficulty = 8
	req := httptest.NewRequest(http.MethodPut, "/api/code-room", strings.NewReader(`{"code":"room-01-il","pow":`+mustProofJSON(t, h, "203.0.113.31")+`}`))
	req.RemoteAddr = "203.0.113.31:12345"
	rec := httptest.NewRecorder()
	h.codeRoomHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("previously ambiguous code status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "/r/ROOM01IL#p=ROOM01IL") {
		t.Fatalf("custom code response did not preserve ambiguous characters: %s", rec.Body.String())
	}
}

func TestWSRejectsInvalidClient(t *testing.T) {
	h := newHub()
	server := httptest.NewServer(http.HandlerFunc(h.apiHandler))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err := websocket.Dial(ctx, wsURL(server.URL, "/api/rooms/testroom/ws?client_id=bad"), nil)
	if err == nil {
		t.Fatal("websocket dial succeeded with invalid client id")
	}
}

func TestWSInvalidMessagePackReturnsServerError(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	server := httptest.NewServer(http.HandlerFunc(h.apiHandler))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn := dialWS(t, ctx, server.URL, "client_aaaaaaaa")
	defer conn.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, ctx, conn, "welcome")

	if err := conn.Write(ctx, websocket.MessageBinary, []byte{0xc1}); err != nil {
		t.Fatal(err)
	}
	readWSEvent(t, ctx, conn, "server_error")
}

func TestWSServerAckAndBroadcast(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	server := httptest.NewServer(http.HandlerFunc(h.apiHandler))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	sender := dialWS(t, ctx, server.URL, "client_sender1")
	defer sender.Close(websocket.StatusNormalClosure, "")
	receiver := dialWS(t, ctx, server.URL, "client_receiver")
	defer receiver.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, ctx, sender, "welcome")
	readWSEvent(t, ctx, receiver, "welcome")

	outbound := wsEnvelope{
		Type:       "group_msg",
		Room:       "testroom",
		From:       "client_sender1",
		Protocol:   protocolVersion,
		EventID:    "evt_0123456789abcdef",
		MsgID:      "msg_1",
		Signature:  make([]byte, 64),
		Nonce:      make([]byte, 24),
		Ciphertext: []byte{1},
	}
	body, err := msgpack.Marshal(outbound)
	if err != nil {
		t.Fatal(err)
	}
	if err := sender.Write(ctx, websocket.MessageBinary, body); err != nil {
		t.Fatal(err)
	}

	ack := readWSEvent(t, ctx, sender, "server_ack")
	if ack.AckID != "msg_1" {
		t.Fatalf("ack id = %q, want msg_1", ack.AckID)
	}
	seen := readWSEvent(t, ctx, receiver, "group_msg")
	if seen.MsgID != "msg_1" || seen.From != "client_sender1" {
		t.Fatalf("broadcast = %+v", seen)
	}
}

func TestWSPrivateMessageTargetsOnlySenderAndRecipient(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	server := httptest.NewServer(http.HandlerFunc(h.apiHandler))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	sender := dialWS(t, ctx, server.URL, "client_sender1")
	defer sender.Close(websocket.StatusNormalClosure, "")
	receiver := dialWS(t, ctx, server.URL, "client_receiver")
	defer receiver.Close(websocket.StatusNormalClosure, "")
	bystander := dialWS(t, ctx, server.URL, "client_bystand")
	defer bystander.Close(websocket.StatusNormalClosure, "")
	readWSEvent(t, ctx, sender, "welcome")
	readWSEvent(t, ctx, receiver, "welcome")
	readWSEvent(t, ctx, bystander, "welcome")

	outbound := wsEnvelope{
		Type:           "private_msg",
		Room:           "testroom",
		From:           "client_sender1",
		To:             "client_receiver",
		Protocol:       protocolVersion,
		EventID:        "evt_0123456789abcdef",
		MsgID:          "msg_private",
		Signature:      make([]byte, 64),
		Nonce:          make([]byte, 24),
		Ciphertext:     []byte{1},
		PublicKey:      make([]byte, 32),
		RecipientKeyID: "recipient_key",
	}
	body, err := msgpack.Marshal(outbound)
	if err != nil {
		t.Fatal(err)
	}
	if err := sender.Write(ctx, websocket.MessageBinary, body); err != nil {
		t.Fatal(err)
	}

	ack := readWSEvent(t, ctx, sender, "server_ack")
	if ack.AckID != "msg_private" {
		t.Fatalf("ack id = %q, want msg_private", ack.AckID)
	}
	seen := readWSEvent(t, ctx, receiver, "private_msg")
	if seen.MsgID != "msg_private" || seen.To != "client_receiver" {
		t.Fatalf("private target event = %+v", seen)
	}
	assertNoWSEvent(t, bystander, 200*time.Millisecond)
}

func TestSSEPrivateMessageTargetsOnlySenderAndRecipient(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	sender := &Client{id: "client_sender1", events: make(chan []byte, 1)}
	receiver := &Client{id: "client_receiver", events: make(chan []byte, 1)}
	bystander := &Client{id: "client_bystand", events: make(chan []byte, 1)}

	h.mu.Lock()
	room := h.roomLocked("testroom")
	room.sseClients[sender.id] = sender
	room.sseClients[receiver.id] = receiver
	room.sseClients[bystander.id] = bystander
	h.mu.Unlock()

	body := []byte(`{"type":"private_msg","room":"testroom","from":"client_sender1","to":"client_receiver"}`)
	h.dispatchSSE("testroom", inboundEvent{Type: "private_msg", Room: "testroom", From: "client_sender1", To: "client_receiver"}, body)

	assertClientMessage(t, sender, body)
	assertClientMessage(t, receiver, body)
	assertNoClientMessage(t, bystander)
}

func TestExplicitPurgeBroadcastsWithoutDisconnecting(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	sender := &Client{id: "client_sender1", token: "token_sender123", events: make(chan []byte, 2)}
	receiver := &Client{id: "client_receiver", events: make(chan []byte, 2)}
	if err := h.addClient("testroom", sender); err != nil {
		t.Fatal(err)
	}
	if err := h.addClient("testroom", receiver); err != nil {
		t.Fatal(err)
	}

	if !h.explicitAction("testroom", sender.id, sender.token, nil, false) {
		t.Fatal("authorized purge was rejected")
	}
	assertJSONEventType(t, sender, "peer_purge")
	assertJSONEventType(t, receiver, "peer_purge")
	if !h.clientOnline("testroom", sender.id) {
		t.Fatal("purge disconnected sender")
	}
	if h.explicitAction("testroom", receiver.id, "wrong_token", nil, false) {
		t.Fatal("purge accepted an invalid connection token")
	}
}

func TestExplicitLeavePurgesAndDisconnects(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	sender := &Client{id: "client_sender1", token: "token_sender123", events: make(chan []byte, 2)}
	receiver := &Client{id: "client_receiver", events: make(chan []byte, 3)}
	if err := h.addClient("testroom", sender); err != nil {
		t.Fatal(err)
	}
	if err := h.addClient("testroom", receiver); err != nil {
		t.Fatal(err)
	}

	if !h.explicitAction("testroom", sender.id, sender.token, nil, true) {
		t.Fatal("authorized leave was rejected")
	}
	assertJSONEventType(t, receiver, "peer_purge")
	assertJSONEventType(t, receiver, "peer_leave")
	if h.clientOnline("testroom", sender.id) {
		t.Fatal("leaving sender is still online")
	}
}

func TestDisconnectGraceReconnectCancelsPurge(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	h.leaveGrace = 25 * time.Millisecond
	old := &Client{id: "client_sender1", events: make(chan []byte, 1)}
	receiver := &Client{id: "client_receiver", events: make(chan []byte, 1)}
	if err := h.addClient("testroom", old); err != nil {
		t.Fatal(err)
	}
	if err := h.addClient("testroom", receiver); err != nil {
		t.Fatal(err)
	}
	if !h.removeClient("testroom", old) {
		t.Fatal("disconnect was not recorded")
	}
	reconnected := &Client{id: old.id, events: make(chan []byte, 1)}
	if err := h.addClient("testroom", reconnected); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	assertNoClientMessage(t, receiver)
	if !h.clientOnline("testroom", old.id) {
		t.Fatal("reconnected client was removed")
	}
}

func TestDisconnectGracePurgesAfterTimeout(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	h.leaveGrace = 10 * time.Millisecond
	sender := &Client{id: "client_sender1", events: make(chan []byte, 1)}
	receiver := &Client{id: "client_receiver", events: make(chan []byte, 1)}
	if err := h.addClient("testroom", sender); err != nil {
		t.Fatal(err)
	}
	if err := h.addClient("testroom", receiver); err != nil {
		t.Fatal(err)
	}
	if !h.removeClient("testroom", sender) {
		t.Fatal("disconnect was not recorded")
	}
	select {
	case body := <-receiver.events:
		var event inboundEvent
		if err := json.Unmarshal(body, &event); err != nil || event.Type != "peer_purge" || event.From != sender.id {
			t.Fatalf("purge event = %s, error = %v", body, err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("timed out waiting for peer_purge")
	}
}

func TestOldConnectionCannotRemoveReplacement(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	old := &Client{id: "client_sender1", events: make(chan []byte, 1)}
	replacement := &Client{id: old.id, events: make(chan []byte, 1)}
	if err := h.addClient("testroom", old); err != nil {
		t.Fatal(err)
	}
	if err := h.addClient("testroom", replacement); err != nil {
		t.Fatal(err)
	}
	if h.removeClient("testroom", old) {
		t.Fatal("old connection removed its replacement")
	}
	if !h.clientOnline("testroom", replacement.id) {
		t.Fatal("replacement connection is not online")
	}
}

func TestRoomConfigurationAndCapacity(t *testing.T) {
	h := newHub()
	if err := h.configureRoom("testroom", 2); err != nil {
		t.Fatal(err)
	}
	first := &Client{id: "client_first01", events: make(chan []byte, 1)}
	second := &Client{id: "client_second1", events: make(chan []byte, 1)}
	third := &Client{id: "client_third01", events: make(chan []byte, 1)}
	if err := h.addClient("testroom", first); err != nil {
		t.Fatal(err)
	}
	if err := h.addWSClient("testroom", second); err != nil {
		t.Fatal(err)
	}
	if err := h.addClient("testroom", third); err == nil {
		t.Fatal("room accepted a client above its configured capacity")
	}
	secondUpgrade := &Client{id: second.id, events: make(chan []byte, 1)}
	if err := h.addClient("testroom", secondUpgrade); err != nil {
		t.Fatalf("same device transport upgrade counted as a new member: %v", err)
	}
}

func TestRoomConfigurationDefaultsAndValidation(t *testing.T) {
	h := newHub()
	room := h.roomLocked("defaultroom")
	if room.maxClients != defaultRoomClients {
		t.Fatalf("default max clients = %d, want %d", room.maxClients, defaultRoomClients)
	}
	if err := h.configureRoom("smallroom", 1); err == nil {
		t.Fatal("accepted max clients below minimum")
	}
	if err := h.configureRoom("largeroom", maxRoomClients+1); err == nil {
		t.Fatal("accepted max clients above maximum")
	}
	if err := h.configureRoom("defaultroom", 8); err != nil {
		t.Fatal(err)
	}
	if err := h.configureRoom("defaultroom", 9); err == nil {
		t.Fatal("room configuration was overwritten")
	}
}

func TestRoomConfigHandler(t *testing.T) {
	h := newHub()
	req := httptest.NewRequest(http.MethodPost, "/api/rooms/testroom/config", strings.NewReader(`{"max_clients":6}`))
	rec := httptest.NewRecorder()
	h.apiHandler(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("config status = %d, want 204: %s", rec.Code, rec.Body.String())
	}
	h.mu.RLock()
	got := h.rooms["testroom"].maxClients
	h.mu.RUnlock()
	if got != 6 {
		t.Fatalf("configured max clients = %d, want 6", got)
	}
}

func TestRoomExpiresAtFixedLifetime(t *testing.T) {
	h := newHub()
	h.roomLifetime = 20 * time.Millisecond
	mustConfigureRoom(t, h, "shortlived")
	client := &Client{id: "client_sender1", events: make(chan []byte, 1)}
	if err := h.addClient("shortlived", client); err != nil {
		t.Fatal(err)
	}
	select {
	case body, ok := <-client.events:
		if !ok {
			t.Fatal("room expired without final room_expired event")
		}
		var event inboundEvent
		if err := json.Unmarshal(body, &event); err != nil || event.Type != "room_expired" {
			t.Fatalf("expiry event = %s, error = %v", body, err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("room did not expire")
	}
	if _, ok := <-client.events; ok {
		t.Fatal("expired room client channel remained open")
	}
	if h.roomActive("shortlived") {
		t.Fatal("expired room remained joinable")
	}
}

func TestSSEMessagesRequireBoundConnectionToken(t *testing.T) {
	h := newHub()
	mustConfigureRoom(t, h, "testroom")
	client := &Client{id: "client_sender1", token: "conn_sender_token", events: make(chan []byte, 1)}
	if err := h.addClient("testroom", client); err != nil {
		t.Fatal(err)
	}
	event := inboundEvent{
		Type: "group_msg", Room: "testroom", From: client.id, Protocol: protocolVersion,
		EventID: "evt_0123456789abcdef", MsgID: "msg_1", Signature: base64.StdEncoding.EncodeToString(make([]byte, 64)),
		Nonce: base64.StdEncoding.EncodeToString(make([]byte, 24)), Ciphertext: base64.StdEncoding.EncodeToString([]byte{1}),
	}
	body, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/rooms/testroom/messages", bytes.NewReader(body))
	req.Header.Set("X-Connection-Token", "conn_wrong_token")
	rec := httptest.NewRecorder()
	h.messagesHandler(rec, req, "testroom")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("mismatched SSE identity status = %d, want 401", rec.Code)
	}
}

func assertJSONEventType(t *testing.T, client *Client, want string) {
	t.Helper()
	select {
	case body, ok := <-client.events:
		if !ok {
			t.Fatalf("client %s closed before %s", client.id, want)
		}
		var event inboundEvent
		if err := json.Unmarshal(body, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type != want {
			t.Fatalf("event type = %q, want %q", event.Type, want)
		}
	default:
		t.Fatalf("client %s did not receive %s", client.id, want)
	}
}

func mustProofJSON(t *testing.T, h *Hub, ip string) string {
	t.Helper()
	challenge, payload, err := h.newPowChallenge(ip, "code")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; ; i++ {
		solution := fmt.Sprintf("test_%d", i)
		hash := sha256.Sum256([]byte(challenge + ":" + solution))
		if hasLeadingZeroBits(hash[:], payload.Difficulty) {
			body, err := json.Marshal(powProof{Challenge: challenge, Solution: solution})
			if err != nil {
				t.Fatal(err)
			}
			return string(body)
		}
	}
}

func dialWS(t *testing.T, ctx context.Context, serverURL, clientID string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.Dial(ctx, wsURL(serverURL, "/api/rooms/testroom/ws?client_id="+clientID), nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func readWSEvent(t *testing.T, ctx context.Context, conn *websocket.Conn, wantType string) wsEnvelope {
	t.Helper()
	for {
		messageType, body, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if messageType != websocket.MessageBinary {
			continue
		}
		var event wsEnvelope
		if err := msgpack.Unmarshal(body, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == wantType {
			return event
		}
	}
}

func assertNoWSEvent(t *testing.T, conn *websocket.Conn, timeout time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	messageType, body, err := conn.Read(ctx)
	if err != nil {
		return
	}
	var event wsEnvelope
	if messageType == websocket.MessageBinary {
		_ = msgpack.Unmarshal(body, &event)
	}
	t.Fatalf("unexpected websocket event for bystander: %+v", event)
}

func assertClientMessage(t *testing.T, client *Client, want []byte) {
	t.Helper()
	select {
	case got := <-client.events:
		if string(got) != string(want) {
			t.Fatalf("client %s got %q, want %q", client.id, got, want)
		}
	default:
		t.Fatalf("client %s did not receive targeted message", client.id)
	}
}

func assertNoClientMessage(t *testing.T, client *Client) {
	t.Helper()
	select {
	case got := <-client.events:
		t.Fatalf("client %s unexpectedly received %q", client.id, got)
	default:
	}
}

func wsURL(serverURL, path string) string {
	return "ws" + strings.TrimPrefix(serverURL, "http") + path
}

func mustConfigureRoom(t *testing.T, h *Hub, roomID string) {
	t.Helper()
	if err := h.configureRoom(roomID, defaultRoomClients); err != nil {
		t.Fatal(err)
	}
}

func TestWSRejectsInvalidEventType(t *testing.T) {
	err := validateWSEvent(wsEnvelope{Type: "bad", Room: "testroom", From: "client_sender1", Protocol: protocolVersion}, "testroom", "client_sender1")
	if err == nil {
		t.Fatal("invalid ws event type accepted")
	}
}

func TestWSRejectsRoomMismatch(t *testing.T) {
	err := validateWSEvent(wsEnvelope{Type: "hello", Room: "other", From: "client_sender1", Protocol: protocolVersion}, "testroom", "client_sender1")
	if err == nil {
		t.Fatal("room mismatch accepted")
	}
}

func TestWSRejectsLegacyProtocol(t *testing.T) {
	err := validateWSEvent(wsEnvelope{Type: "group_msg", Room: "testroom", From: "client_sender1", Protocol: 2, MsgID: "legacy", Signature: make([]byte, 64)}, "testroom", "client_sender1")
	if err == nil {
		t.Fatal("protocol v2 event accepted")
	}
}

func TestSSERequiresBase64BinaryFields(t *testing.T) {
	event := inboundEvent{Type: "hello", Room: "testroom", From: "client_sender1", Protocol: protocolVersion, EventID: "evt_0123456789abcdef", SenderKeyID: "key_1", PublicKey: "not-base64", SignPublicKey: base64.StdEncoding.EncodeToString(make([]byte, 32)), HelloMAC: base64.StdEncoding.EncodeToString(make([]byte, 32)), Signature: base64.StdEncoding.EncodeToString(make([]byte, 64))}
	if err := validateSSEEvent(event); err == nil {
		t.Fatal("invalid SSE base64 accepted")
	}
}

func TestTransportConversionPreservesBinaryBytes(t *testing.T) {
	want := []byte{0, 1, 2, 253, 254, 255}
	event := inboundEvent{Type: "group_msg", Room: "testroom", From: "client_sender1", Protocol: protocolVersion, EventID: "evt_0123456789abcdef", MsgID: "msg_1", Signature: base64.StdEncoding.EncodeToString(make([]byte, 64)), Ciphertext: base64.StdEncoding.EncodeToString(want)}
	wsEvent, err := event.toWS()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(wsEvent.Ciphertext, want) {
		t.Fatalf("binary conversion = %v, want %v", wsEvent.Ciphertext, want)
	}
	body, err := msgpack.Marshal(wsEvent)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := msgpack.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, ok := decoded["ciphertext"].([]byte); !ok {
		t.Fatalf("websocket ciphertext encoded as %T, want MessagePack binary", decoded["ciphertext"])
	}
}

func TestWSRejectsOversizedChunkPlan(t *testing.T) {
	event := wsEnvelope{
		Type: "chunk", Room: "testroom", From: "client_sender1", Protocol: protocolVersion,
		EventID: "evt_0123456789abcdef", MsgID: "msg_1:0", TransferID: "msg_1", MessageType: "group_msg",
		Total: maxChunkCount + 1, Signature: make([]byte, 64), Nonce: make([]byte, 24), Ciphertext: []byte{1},
	}
	if err := validateWSEvent(event, "testroom", "client_sender1"); err == nil {
		t.Fatal("oversized chunk plan accepted")
	}
}
