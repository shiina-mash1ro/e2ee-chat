package main

import (
	"context"
	"crypto/sha256"
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

func TestJoinCodeRoomRejectsAmbiguousCode(t *testing.T) {
	h := newHub()
	h.powDifficulty = 8
	req := httptest.NewRequest(http.MethodPut, "/api/code-room", strings.NewReader(`{"code":"ROOM01","pow":`+mustProofJSON(t, h, "203.0.113.31")+`}`))
	req.RemoteAddr = "203.0.113.31:12345"
	rec := httptest.NewRecorder()
	h.codeRoomHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ambiguous code status = %d, want 400", rec.Code)
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
		Type:     "group_msg",
		Room:     "testroom",
		From:     "client_sender1",
		Protocol: 2,
		MsgID:    "msg_1",
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
		Type:     "private_msg",
		Room:     "testroom",
		From:     "client_sender1",
		To:       "client_receiver",
		Protocol: 2,
		MsgID:    "msg_private",
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

func TestWSRejectsInvalidEventType(t *testing.T) {
	err := validateWSEvent(wsEnvelope{Type: "bad", Room: "testroom", From: "client_sender1", Protocol: 2}, "testroom", "client_sender1")
	if err == nil {
		t.Fatal("invalid ws event type accepted")
	}
}

func TestWSRejectsRoomMismatch(t *testing.T) {
	err := validateWSEvent(wsEnvelope{Type: "hello", Room: "other", From: "client_sender1", Protocol: 2}, "testroom", "client_sender1")
	if err == nil {
		t.Fatal("room mismatch accepted")
	}
}
