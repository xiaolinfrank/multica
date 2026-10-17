package daemonws

// DisconnectAll is used only by the opt-in single-owner credential reset.
// Tokens have already been revoked before connections are closed.
func (h *Hub) DisconnectAll() {
	if h == nil {
		return
	}
	h.mu.RLock()
	clients := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()
	for _, c := range clients {
		if c.conn != nil {
			c.conn.Close()
		}
	}
}
