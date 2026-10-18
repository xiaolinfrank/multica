package realtime

// DisconnectUser closes existing sockets after a local credential reset.
// The normal read pumps retain ownership of unregistering room membership.
func (h *Hub) DisconnectUser(userID string) {
	if h == nil {
		return
	}
	h.mu.RLock()
	clients := make([]*Client, 0)
	for c := range h.clients {
		if c.userID == userID {
			clients = append(clients, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range clients {
		if c.conn != nil {
			c.conn.Close()
		}
	}
}
