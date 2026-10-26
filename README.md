# Gather

Gather is a real-time, one-to-one chat application built with Express, Socket.IO, and a persistent SQLite database. It includes password-protected user accounts, searchable conversations, live messages, typing indicators, and online/offline status.

## Requirements

- Node.js 18 or later
- npm
- A private JWT signing secret

## Run locally

In PowerShell:

```powershell
$env:JWT_SECRET = "replace-with-a-long-random-secret"
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Create accounts in two browsers or browser profiles to try a conversation. Messages and accounts persist in `data/chat.sqlite`, which is created automatically on first startup.

Use `npm run dev` to run with Node's built-in file watcher. Set `PORT` to change the listening port.

## Features

- Register and sign in with unique usernames and hashed passwords.
- Start private conversations with registered users; existing one-to-one conversations are reused.
- Send and receive messages over authenticated WebSocket connections.
- Load recent conversation history when you sign in or reopen a conversation.
- See typing and online/offline updates in real time.
- Search conversations and find registered users by username.

Passwords are hashed with bcrypt. HTTP requests and WebSocket handshakes are authenticated with signed, expiring tokens. A conversation's membership is checked before its history is returned, and again before sending or relaying chat events.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `JWT_SECRET` | Yes | — | Private secret used to sign authentication tokens. |
| `PORT` | No | `3000` | HTTP and WebSocket port. |
