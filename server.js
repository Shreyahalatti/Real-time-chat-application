const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const initSqlJs = require("sql.js");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_LIFETIME = "7d";
const DATA_DIRECTORY = path.join(__dirname, "data");
const DATABASE_PATH = path.join(DATA_DIRECTORY, "chat.sqlite");

if (!JWT_SECRET) {
  console.error("JWT_SECRET is required. Set it in your environment before starting the server.");
  process.exit(1);
}

function createApplication(database) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const onlineUsers = new Map();

  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  function query(sql, parameters = []) {
    const statement = database.prepare(sql);
    try {
      statement.bind(parameters);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  function execute(sql, parameters = []) {
    database.run(sql, parameters);
    persistDatabase();
  }

  function persistDatabase() {
    fs.writeFileSync(DATABASE_PATH, Buffer.from(database.export()));
  }

  function createToken(user) {
    return jwt.sign({ sub: String(user.id), username: user.username }, JWT_SECRET, {
      expiresIn: TOKEN_LIFETIME,
    });
  }

  function authenticateToken(token) {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = query("SELECT id, username FROM users WHERE id = ?", [Number(payload.sub)])[0];
    if (!user) throw new Error("Account not found.");
    return user;
  }

  function authenticateRequest(request, response, next) {
    const authorization = request.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    try {
      request.user = authenticateToken(token);
      next();
    } catch {
      response.status(401).json({ error: "Your session has expired. Please sign in again." });
    }
  }

  function getConversation(conversationId, userId) {
    const conversation = query(
      `SELECT c.id, c.name, c.is_group, c.created_at
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE c.id = ? AND cm.user_id = ?`,
      [conversationId, userId],
    )[0];
    if (!conversation) return null;
    conversation.members = query(
      `SELECT u.id, u.username
       FROM users u
       JOIN conversation_members cm ON cm.user_id = u.id
       WHERE cm.conversation_id = ?
       ORDER BY u.username COLLATE NOCASE`,
      [conversationId],
    );
    return conversation;
  }

  function getMessage(messageId) {
    return query(
      `SELECT m.id, m.conversation_id, m.sender_id, u.username AS sender_username,
              m.body, m.created_at
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = ?`,
      [messageId],
    )[0];
  }

  function isConversationMember(conversationId, userId) {
    return query(
      "SELECT 1 AS member FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
      [conversationId, userId],
    ).length > 0;
  }

  function broadcastPresence(userId, status) {
    io.emit("presence:update", { userId, status });
  }

  app.post("/api/auth/register", async (request, response) => {
    const username = typeof request.body.username === "string" ? request.body.username.trim() : "";
    const password = typeof request.body.password === "string" ? request.body.password : "";
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return response.status(400).json({
        error: "Username must be 3–20 characters and contain only letters, numbers, and underscores.",
      });
    }
    if (password.length < 8 || password.length > 72) {
      return response.status(400).json({ error: "Password must be between 8 and 72 characters." });
    }
    if (query("SELECT id FROM users WHERE username = ? COLLATE NOCASE", [username]).length) {
      return response.status(409).json({ error: "That username is already taken." });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", [username, passwordHash]);
      const user = query("SELECT id, username FROM users WHERE username = ?", [username])[0];
      response.status(201).json({ token: createToken(user), user });
    } catch (error) {
      console.error("Account registration failed:", error);
      response.status(500).json({ error: "Unable to create your account right now." });
    }
  });

  app.post("/api/auth/login", async (request, response) => {
    const username = typeof request.body.username === "string" ? request.body.username.trim() : "";
    const password = typeof request.body.password === "string" ? request.body.password : "";
    const user = query("SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE", [
      username,
    ])[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return response.status(401).json({ error: "Incorrect username or password." });
    }
    response.json({
      token: createToken(user),
      user: { id: user.id, username: user.username },
    });
  });

  app.get("/api/auth/session", authenticateRequest, (request, response) => {
    response.json({ user: request.user });
  });

  app.get("/api/users", authenticateRequest, (request, response) => {
    const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
    if (!search) return response.json([]);
    const users = query(
      `SELECT id, username FROM users
       WHERE id != ? AND username LIKE ? ESCAPE '\\' COLLATE NOCASE
       ORDER BY username COLLATE NOCASE LIMIT 10`,
      [request.user.id, `%${search.replace(/[\\%_]/g, "\\$&")}%`],
    );
    response.json(users);
  });

  app.get("/api/conversations", authenticateRequest, (request, response) => {
    const conversations = query(
      `SELECT c.id, c.name, c.is_group, c.created_at,
              m.body AS last_message, m.created_at AS last_message_at
       FROM conversations c
       JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = ?
       LEFT JOIN messages m ON m.id = (
         SELECT latest.id FROM messages latest
         WHERE latest.conversation_id = c.id
         ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
       )
       ORDER BY COALESCE(m.created_at, c.created_at) DESC`,
      [request.user.id],
    );
    for (const conversation of conversations) {
      conversation.members = getConversation(conversation.id, request.user.id).members;
    }
    response.json(conversations);
  });

  app.post("/api/conversations", authenticateRequest, (request, response) => {
    const username = typeof request.body.username === "string" ? request.body.username.trim() : "";
    const otherUser = query("SELECT id FROM users WHERE username = ? COLLATE NOCASE", [username])[0];
    if (!otherUser || otherUser.id === request.user.id) {
      return response.status(404).json({ error: "Choose another registered username to start a chat." });
    }

    const existing = query(
      `SELECT c.id FROM conversations c
       JOIN conversation_members first_member ON first_member.conversation_id = c.id
       JOIN conversation_members second_member ON second_member.conversation_id = c.id
       WHERE c.is_group = 0
         AND first_member.user_id = ? AND second_member.user_id = ?
         AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) = 2`,
      [request.user.id, otherUser.id],
    )[0];
    if (existing) return response.json(getConversation(existing.id, request.user.id));

    database.run("BEGIN TRANSACTION");
    try {
      database.run("INSERT INTO conversations (is_group) VALUES (0)");
      const conversationId = database.exec("SELECT last_insert_rowid() AS id")[0].values[0][0];
      database.run(
        "INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?), (?, ?)",
        [conversationId, request.user.id, conversationId, otherUser.id],
      );
      database.run("COMMIT");
      persistDatabase();
      io.to(`user:${otherUser.id}`).emit("conversation:created", { conversationId });
      response.status(201).json(getConversation(conversationId, request.user.id));
    } catch (error) {
      database.run("ROLLBACK");
      console.error("Conversation creation failed:", error);
      response.status(500).json({ error: "Unable to start a conversation right now." });
    }
  });

  app.get("/api/conversations/:id/messages", authenticateRequest, (request, response) => {
    const conversationId = Number(request.params.id);
    if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
      return response.status(400).json({ error: "Invalid conversation." });
    }
    if (!isConversationMember(conversationId, request.user.id)) {
      return response.status(404).json({ error: "Conversation not found." });
    }
    const before = request.query.before ? Number(request.query.before) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1) {
      return response.status(400).json({ error: "Invalid message cursor." });
    }
    const messages = query(
      `SELECT m.id, m.conversation_id, m.sender_id, u.username AS sender_username,
              m.body, m.created_at
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? AND m.id < ?
       ORDER BY m.id DESC LIMIT 100`,
      [conversationId, before],
    );
    response.json(messages.reverse());
  });

  io.use((socket, next) => {
    try {
      socket.user = authenticateToken(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error("Authentication required. Please sign in again."));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId, username } = socket.user;
    socket.join(`user:${userId}`);
    const sockets = onlineUsers.get(userId) || new Set();
    const wasOffline = sockets.size === 0;
    sockets.add(socket.id);
    onlineUsers.set(userId, sockets);
    if (wasOffline) broadcastPresence(userId, "online");

    for (const conversation of query(
      "SELECT conversation_id FROM conversation_members WHERE user_id = ?",
      [userId],
    )) {
      socket.join(`conversation:${conversation.conversation_id}`);
    }

    socket.emit("presence:initial", [...onlineUsers.keys()]);

    socket.on("conversation:join", (payload) => {
      const conversationId = Number(payload?.conversationId);
      if (
        Number.isSafeInteger(conversationId) &&
        conversationId > 0 &&
        isConversationMember(conversationId, userId)
      ) {
        socket.join(`conversation:${conversationId}`);
      }
    });

    socket.on("conversation:created", (payload) => {
      const conversationId = Number(payload?.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId < 1) return;
      const conversation = getConversation(conversationId, userId);
      if (!conversation) return;
      socket.join(`conversation:${conversationId}`);
      socket.emit("conversation:available", conversation);
    });

    socket.on("message:send", (payload, acknowledge) => {
      const reply = typeof acknowledge === "function" ? acknowledge : () => {};
      const conversationId = Number(payload?.conversationId);
      const body = typeof payload?.body === "string" ? payload.body.trim() : "";
      if (!Number.isSafeInteger(conversationId) || conversationId < 1 || !body || body.length > 4000) {
        return reply({ error: "Messages must contain between 1 and 4000 characters." });
      }
      if (!isConversationMember(conversationId, userId)) {
        return reply({ error: "You are not a member of that conversation." });
      }
      try {
        execute(
          "INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)",
          [conversationId, userId, body],
        );
        const messageId = database.exec("SELECT last_insert_rowid() AS id")[0].values[0][0];
        const message = getMessage(messageId);
        io.to(`conversation:${conversationId}`).emit("message:new", message);
        reply({ message });
      } catch (error) {
        console.error("Message could not be saved:", error);
        reply({ error: "Your message could not be saved. Please try again." });
      }
    });

    socket.on("typing:update", (payload) => {
      const conversationId = Number(payload?.conversationId);
      if (
        !Number.isSafeInteger(conversationId) ||
        conversationId < 1 ||
        !isConversationMember(conversationId, userId)
      ) {
        return;
      }
      socket.to(`conversation:${conversationId}`).emit("typing:update", {
        conversationId,
        userId,
        username,
        isTyping: Boolean(payload.isTyping),
      });
    });

    socket.on("disconnect", () => {
      const remainingSockets = onlineUsers.get(userId);
      if (!remainingSockets) return;
      remainingSockets.delete(socket.id);
      if (remainingSockets.size === 0) {
        onlineUsers.delete(userId);
        broadcastPresence(userId, "offline");
      }
    });
  });

  return server;
}

async function startServer() {
  fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
  const SQL = await initSqlJs();
  const database = fs.existsSync(DATABASE_PATH)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(DATABASE_PATH)))
    : new SQL.Database();

  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      is_group INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_id_id
      ON messages (conversation_id, id);
  `);
  fs.writeFileSync(DATABASE_PATH, Buffer.from(database.export()));

  const server = createApplication(database);
  server.listen(PORT, () => {
    console.log(`Chat server running at http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Unable to start the chat server:", error);
  process.exitCode = 1;
});
