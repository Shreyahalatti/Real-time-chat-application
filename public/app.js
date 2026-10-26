(() => {
  const authScreen = document.querySelector("#auth-screen");
  const chatShell = document.querySelector("#chat-shell");
  const authForm = document.querySelector("#auth-form");
  const authError = document.querySelector("#auth-error");
  const authTitle = document.querySelector("#auth-title");
  const authSubmit = document.querySelector("#auth-submit");
  const passwordInput = document.querySelector("#password");
  const loginTab = document.querySelector("#login-tab");
  const registerTab = document.querySelector("#register-tab");
  const conversationList = document.querySelector("#conversation-list");
  const messageList = document.querySelector("#message-list");
  const messagesArea = document.querySelector("#messages-area");
  const messageForm = document.querySelector("#message-form");
  const messageInput = document.querySelector("#message-input");
  const sendButton = document.querySelector("#send-button");
  const typingIndicator = document.querySelector("#typing-indicator");
  const dialog = document.querySelector("#new-chat-dialog");
  const newChatForm = document.querySelector("#new-chat-form");
  const newChatUsername = document.querySelector("#new-chat-username");
  const dialogError = document.querySelector("#dialog-error");
  const suggestions = document.querySelector("#user-suggestions");
  const toast = document.querySelector("#toast");

  let token = localStorage.getItem("gather-token");
  let currentUser = null;
  let socket = null;
  let conversations = [];
  let activeConversation = null;
  let messages = [];
  let onlineUserIds = new Set();
  let typingUsers = new Map();
  let isRegistering = false;
  let typingTimeout = null;
  let toastTimeout = null;
  let suggestionsTimeout = null;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && token) signOut();
      throw new Error(data.error || "Something went wrong. Please try again.");
    }
    return data;
  }

  function showAuthError(message) {
    authError.textContent = message;
    authError.hidden = !message;
  }

  function showDialogError(message) {
    dialogError.textContent = message;
    dialogError.hidden = !message;
  }

  function setAuthMode(register) {
    isRegistering = register;
    loginTab.classList.toggle("active", !register);
    registerTab.classList.toggle("active", register);
    loginTab.setAttribute("aria-selected", String(!register));
    registerTab.setAttribute("aria-selected", String(register));
    authTitle.innerHTML = register ? "Your people are<br />just a hello away." : "Good conversations<br />start here.";
    authSubmit.innerHTML = register ? "Create my account <span aria-hidden=\"true\">→</span>" : "Sign in <span aria-hidden=\"true\">→</span>";
    passwordInput.autocomplete = register ? "new-password" : "current-password";
    showAuthError("");
  }

  loginTab.addEventListener("click", () => setAuthMode(false));
  registerTab.addEventListener("click", () => setAuthMode(true));

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showAuthError("");
    authSubmit.disabled = true;
    const formData = new FormData(authForm);
    try {
      const result = await api(`/api/auth/${isRegistering ? "register" : "login"}`, {
        method: "POST",
        body: JSON.stringify({
          username: formData.get("username"),
          password: formData.get("password"),
        }),
      });
      token = result.token;
      currentUser = result.user;
      localStorage.setItem("gather-token", token);
      await openChat();
    } catch (error) {
      showAuthError(error.message);
    } finally {
      authSubmit.disabled = false;
    }
  });

  function initials(username) {
    return username?.trim().slice(0, 1).toUpperCase() || "?";
  }

  function avatarMarkup(username) {
    return `<span class="avatar">${escapeHTML(initials(username))}</span>`;
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function relativeTime(dateString) {
    if (!dateString) return "";
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "";
    const elapsed = Date.now() - date.getTime();
    if (elapsed < 60_000) return "now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatMessageTime(dateString) {
    const date = new Date(dateString);
    return Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function formatDay(dateString) {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const difference = (today - messageDay) / 86_400_000;
    if (difference === 0) return "Today";
    if (difference === 1) return "Yesterday";
    return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  }

  function getConversationName(conversation) {
    if (conversation.name) return conversation.name;
    const otherUser = conversation.members?.find((member) => member.id !== currentUser?.id);
    return otherUser?.username || "Conversation";
  }

  function renderConversations() {
    const search = document.querySelector("#conversation-search").value.trim().toLowerCase();
    const visible = conversations.filter((conversation) =>
      getConversationName(conversation).toLowerCase().includes(search),
    );
    document.querySelector("#message-count").textContent = String(conversations.length);
    if (visible.length === 0) {
      conversationList.innerHTML = `<div class="empty-conversations">${search ? "No conversations match your search." : "No conversations yet.<br>Say hello to someone to get started."}</div>`;
      return;
    }
    conversationList.innerHTML = visible.map((conversation) => {
      const name = getConversationName(conversation);
      const otherUser = conversation.members.find((member) => member.id !== currentUser.id);
      const online = otherUser ? onlineUserIds.has(otherUser.id) : false;
      return `<button class="conversation-row${activeConversation?.id === conversation.id ? " active" : ""}" data-id="${conversation.id}" type="button">
        <span class="avatar">${escapeHTML(initials(name))}</span>
        <span class="conversation-copy">
          <span class="conversation-topline"><span class="conversation-name">${escapeHTML(name)}</span><span class="conversation-time">${escapeHTML(relativeTime(conversation.last_message_at))}</span></span>
          <span class="conversation-bottomline"><span class="conversation-preview">${escapeHTML(conversation.last_message || (online ? "Online now" : "Start a conversation"))}</span></span>
        </span>
      </button>`;
    }).join("");
    conversationList.querySelectorAll(".conversation-row").forEach((button) => {
      button.addEventListener("click", () => selectConversation(Number(button.dataset.id)));
    });
  }

  function renderHeader() {
    if (!activeConversation) {
      document.querySelector("#chat-header").innerHTML = `<div class="header-placeholder"><span class="placeholder-dot"></span><span>Your space to say hello</span></div>`;
      return;
    }
    const name = getConversationName(activeConversation);
    const otherUser = activeConversation.members.find((member) => member.id !== currentUser.id);
    const online = otherUser ? onlineUserIds.has(otherUser.id) : false;
    document.querySelector("#chat-header").innerHTML = `
      <div class="chat-contact">${avatarMarkup(name)}<div>
        <div class="contact-name">${escapeHTML(name)}</div>
        <div class="contact-presence${online ? " online" : ""}">${online ? "Online now" : "Offline"}</div>
      </div></div>
      <div class="header-lock"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg> Just between you</div>`;
  }

  function renderMessages() {
    const isEmpty = messages.length === 0;
    document.querySelector("#welcome-state").hidden = Boolean(activeConversation);
    messageList.hidden = !activeConversation;
    messageList.innerHTML = "";
    if (!activeConversation || isEmpty) return;

    let previousDay = "";
    for (const message of messages) {
      const day = formatDay(message.created_at);
      if (day !== previousDay) {
        const divider = document.createElement("div");
        divider.className = "day-divider";
        divider.textContent = day;
        messageList.append(divider);
        previousDay = day;
      }
      const ownMessage = message.sender_id === currentUser.id;
      const element = document.createElement("article");
      element.className = `message${ownMessage ? " own-message" : ""}`;
      element.innerHTML = `
        ${avatarMarkup(message.sender_username)}
        <div class="message-body">
          <div class="message-meta"><span class="message-author">${ownMessage ? "You" : escapeHTML(message.sender_username)}</span><time class="message-time" datetime="${escapeHTML(message.created_at)}">${escapeHTML(formatMessageTime(message.created_at))}</time></div>
          <div class="message-bubble">${escapeHTML(message.body)}</div>
        </div>`;
      messageList.append(element);
    }
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function renderTypingIndicator() {
    const names = [...typingUsers.values()];
    typingIndicator.textContent = names.length
      ? `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} typing…`
      : "";
  }

  function addMessage(message) {
    if (messages.some((existing) => existing.id === message.id)) return;
    const conversation = conversations.find((item) => item.id === message.conversation_id);
    if (conversation) {
      conversation.last_message = message.body;
      conversation.last_message_at = message.created_at;
      conversations.sort((first, second) => new Date(second.last_message_at || second.created_at) - new Date(first.last_message_at || first.created_at));
      renderConversations();
    }
    if (activeConversation?.id === message.conversation_id) {
      messages.push(message);
      messages.sort((first, second) => first.id - second.id);
      renderMessages();
    }
  }

  function resetTyping() {
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = null;
    if (socket && activeConversation) {
      socket.emit("typing:update", { conversationId: activeConversation.id, isTyping: false });
    }
  }

  async function selectConversation(conversationId) {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    resetTyping();
    activeConversation = conversation;
    messages = [];
    typingUsers.clear();
    renderConversations();
    renderHeader();
    renderMessages();
    renderTypingIndicator();
    messageInput.disabled = false;
    sendButton.disabled = false;
    chatShell.classList.add("mobile-chat-open");
    try {
      messages = await api(`/api/conversations/${conversation.id}/messages`);
      if (activeConversation?.id === conversation.id) renderMessages();
    } catch (error) {
      showToast(error.message);
    }
    messageInput.focus();
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("visible"), 3500);
  }

  function connectSocket() {
    if (socket) socket.disconnect();
    socket = window.io({ auth: { token } });
    socket.on("connect_error", (error) => {
      showToast(error.message || "Unable to connect to chat.");
    });
    socket.on("presence:initial", (userIds) => {
      onlineUserIds = new Set(userIds);
      renderConversations();
      renderHeader();
    });
    socket.on("presence:update", ({ userId, status }) => {
      if (status === "online") onlineUserIds.add(userId);
      else onlineUserIds.delete(userId);
      renderConversations();
      renderHeader();
    });
    socket.on("conversation:created", ({ conversationId }) => {
      socket.emit("conversation:created", { conversationId });
    });
    socket.on("conversation:available", (conversation) => {
      if (!conversations.some((item) => item.id === conversation.id)) {
        conversations.unshift(conversation);
        renderConversations();
        showToast(`${getConversationName(conversation)} started a conversation.`);
      }
    });
    socket.on("message:new", addMessage);
    socket.on("typing:update", ({ conversationId, userId, username, isTyping }) => {
      if (conversationId !== activeConversation?.id || userId === currentUser.id) return;
      if (isTyping) typingUsers.set(userId, username);
      else typingUsers.delete(userId);
      renderTypingIndicator();
    });
  }

  async function openChat() {
    authScreen.hidden = true;
    chatShell.hidden = false;
    chatShell.classList.remove("mobile-chat-open");
    document.querySelector("#current-username").textContent = currentUser.username;
    document.querySelector("#current-user-avatar").textContent = initials(currentUser.username);
    conversations = await api("/api/conversations");
    renderConversations();
    connectSocket();
    if (conversations.length && window.matchMedia("(min-width: 561px)").matches) {
      await selectConversation(conversations[0].id);
    } else {
      activeConversation = null;
      renderHeader();
      renderMessages();
      messageInput.disabled = true;
      sendButton.disabled = true;
    }
  }

  function signOut() {
    if (socket) socket.disconnect();
    socket = null;
    token = null;
    currentUser = null;
    conversations = [];
    activeConversation = null;
    messages = [];
    onlineUserIds.clear();
    localStorage.removeItem("gather-token");
    chatShell.hidden = true;
    authScreen.hidden = false;
    authForm.reset();
  }

  document.querySelector("#logout-button").addEventListener("click", signOut);
  document.querySelector("#conversation-search").addEventListener("input", renderConversations);
  document.querySelector("#compose-button").addEventListener("click", openNewChatDialog);
  document.querySelector("#welcome-compose").addEventListener("click", openNewChatDialog);
  document.querySelector("#dialog-close").addEventListener("click", () => dialog.close());
  document.querySelector("#chat-header").addEventListener("click", (event) => {
    if (event.target === event.currentTarget && chatShell.classList.contains("mobile-chat-open")) {
      chatShell.classList.remove("mobile-chat-open");
      resetTyping();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) && !dialog.open) {
      event.preventDefault();
      document.querySelector("#conversation-search").focus();
    }
    if (event.key === "Escape" && chatShell.classList.contains("mobile-chat-open")) {
      chatShell.classList.remove("mobile-chat-open");
      resetTyping();
    }
  });

  function openNewChatDialog() {
    newChatForm.reset();
    suggestions.innerHTML = "";
    showDialogError("");
    dialog.showModal();
    newChatUsername.focus();
  }

  newChatUsername.addEventListener("input", () => {
    showDialogError("");
    if (suggestionsTimeout) clearTimeout(suggestionsTimeout);
    const search = newChatUsername.value.trim();
    if (search.length < 2) {
      suggestions.innerHTML = "";
      return;
    }
    suggestionsTimeout = setTimeout(async () => {
      try {
        const users = await api(`/api/users?search=${encodeURIComponent(search)}`);
        if (!dialog.open || newChatUsername.value.trim() !== search || users.length === 0) {
          suggestions.innerHTML = "";
          return;
        }
        suggestions.innerHTML = `<p class="suggestion-label">PEOPLE YOU CAN MESSAGE</p>${users.map((user) =>
          `<button class="suggestion-user" type="button" data-username="${escapeHTML(user.username)}">${avatarMarkup(user.username)}${escapeHTML(user.username)}</button>`,
        ).join("")}`;
        suggestions.querySelectorAll(".suggestion-user").forEach((button) => {
          button.addEventListener("click", () => {
            newChatUsername.value = button.dataset.username;
            newChatForm.requestSubmit();
          });
        });
      } catch {
        suggestions.innerHTML = "";
      }
    }, 180);
  });

  newChatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showDialogError("");
    const submit = newChatForm.querySelector(".dialog-submit");
    submit.disabled = true;
    try {
      const conversation = await api("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ username: newChatUsername.value }),
      });
      if (!conversations.some((item) => item.id === conversation.id)) {
        conversations.unshift(conversation);
        if (socket?.connected) socket.emit("conversation:join", { conversationId: conversation.id });
      }
      dialog.close();
      await selectConversation(conversation.id);
    } catch (error) {
      showDialogError(error.message);
    } finally {
      submit.disabled = false;
    }
  });

  messageInput.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 110)}px`;
    if (!socket || !activeConversation) return;
    socket.emit("typing:update", { conversationId: activeConversation.id, isTyping: true });
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(resetTyping, 1200);
  });

  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      messageForm.requestSubmit();
    }
  });

  messageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = messageInput.value.trim();
    if (!body || !socket?.connected || !activeConversation) return;
    const conversationId = activeConversation.id;
    socket.emit("message:send", { conversationId, body }, (result) => {
      if (result?.error) {
        showToast(result.error);
        return;
      }
      if (result?.message) addMessage(result.message);
      if (activeConversation?.id === conversationId) {
        messageInput.value = "";
        messageInput.style.height = "auto";
      }
    });
    resetTyping();
  });

  if (token) {
    api("/api/auth/session")
      .then((session) => {
        currentUser = session.user;
        return openChat();
      })
      .catch(() => {
        token = null;
        localStorage.removeItem("gather-token");
        authScreen.hidden = false;
        chatShell.hidden = true;
      });
  }
})();
