"use strict";

const $ = selector => document.querySelector(selector);
const $all = selector => Array.from(document.querySelectorAll(selector));
const state = {
  user: null,
  listings: [],
  category: "All",
  search: "",
  duration: "all",
  sort: "recommended"
};

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

function formatPrice(value) {
  return `Rs. ${Number(value || 0).toLocaleString("en-IN")}`;
}

function formatDate(value) {
  if (!value) return "Not selected";
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric"
  });
}

function todayString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

function notify(message, isError = false) {
  let notice = $("#rentifyNotice");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "rentifyNotice";
    notice.setAttribute("role", "status");
    notice.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:99999;max-width:360px;padding:14px 18px;border-radius:12px;background:#202124;color:#fff;font:14px/1.5 Arial,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.2)";
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  notice.style.background = isError ? "#8b2525" : "#202124";
  notice.style.display = "block";
  clearTimeout(notice.hideTimer);
  notice.hideTimer = setTimeout(() => { notice.style.display = "none"; }, 4000);
}

function showAuth(register = false) {
  $("#authScreen").classList.remove("hidden");
  $("#appScreen").classList.add("hidden");
  if (register) showRegisterForm();
  else showLoginForm();
}

function showApp() {
  $("#authScreen").classList.add("hidden");
  $("#appScreen").classList.remove("hidden");
  updateUserInterface();
  renderCategories();
  loadListings().catch(error => notify(error.message, true));
}

function showLoginForm() {
  $("#loginPanel").classList.remove("hidden");
  $("#registerPanel").classList.add("hidden");
  $all("[data-auth]").forEach(button => button.classList.toggle("active", button.dataset.auth === "login"));
}

function showRegisterForm() {
  $("#loginPanel").classList.add("hidden");
  $("#registerPanel").classList.remove("hidden");
  $all("[data-auth]").forEach(button => button.classList.toggle("active", button.dataset.auth === "register"));
}

function updateUserInterface() {
  const account = $("#accountBtn");
  if (account) account.textContent = state.user ? "My account" : "Log in";
  const logout = $("#logoutBtn");
  if (logout) logout.classList.toggle("hidden", !state.user);
  const listButton = $("#listItemBtn");
  if (listButton) {
    listButton.disabled = !state.user;
    listButton.title = state.user ? "List an item for rent" : "Log in to list an item";
  }
}

function visibleListings() {
  const term = state.search.trim().toLowerCase();
  let result = state.listings.filter(item => {
    const categoryMatch = state.category === "All" || item.category === state.category;
    const searchable = `${item.name} ${item.category} ${item.location} ${item.description}`.toLowerCase();
    const searchMatch = !term || searchable.includes(term);
    const durationMatch = state.duration === "all" || item.unit === state.duration;
    return categoryMatch && searchMatch && durationMatch;
  });
  if (state.sort === "low") result = result.slice().sort((a, b) => a.price - b.price);
  if (state.sort === "high") result = result.slice().sort((a, b) => b.price - a.price);
  if (state.sort === "name") result = result.slice().sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

function renderCategories() {
  $all("[data-category]").forEach(button => {
    button.classList.toggle("active", button.dataset.category === state.category);
  });
}

function renderListings() {
  const grid = $("#productGrid");
  if (!grid) return;
  const items = visibleListings();
  $("#resultCount").textContent = `${items.length} item${items.length === 1 ? "" : "s"} available`;
  $("#resultsTitle").textContent = state.category === "All" ? "Available rentals" : `${state.category} rentals`;
  $("#emptyState").classList.toggle("hidden", items.length > 0);
  grid.innerHTML = items.map(item => `
    <article class="product-card">
      <img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.name)}" loading="lazy">
      <div class="product-body">
        <div class="product-head">
          <div><p class="product-category">${escapeHTML(item.category)}</p><h3>${escapeHTML(item.name)}</h3></div>
          <span class="product-price">${formatPrice(item.price)}</span>
        </div>
        <p class="product-meta">${escapeHTML(item.location)} · per day</p>
        <p class="product-desc">${escapeHTML(item.description)}</p>
        <div class="product-footer">
          <div class="owner-meta"><span class="avatar">${escapeHTML((item.ownerName || "Owner").slice(0, 2).toUpperCase())}</span>
            <div><strong>${escapeHTML(item.ownerName || "Owner")}</strong><small>${item.ownerRating || 5} ★</small></div>
          </div>
          <button class="reserve-btn" data-item-id="${item.id}" ${item.ownerId === state.user?.id ? "disabled title=\"Your own listing\"" : ""}>Reserve</button>
        </div>
      </div>
    </article>`).join("");
}

async function loadListings() {
  const result = await api("/api/items");
  state.listings = result.items;
  renderListings();
}

function openModal(content) {
  $("#modalContent").innerHTML = content;
  $("#modalBackdrop").classList.remove("hidden");
  $("#modalBackdrop").setAttribute("aria-hidden", "false");
}

function closeModal() {
  $("#modalBackdrop").classList.add("hidden");
  $("#modalBackdrop").setAttribute("aria-hidden", "true");
}

function itemListingForm() {
  openModal(`
    <h2 id="modalTitle">List an item</h2>
    <p class="muted">Tell renters what you have available. Your listing is published right away.</p>
    <form id="listingForm" class="modal-form">
      <label>Item name<input name="name" minlength="3" maxlength="100" required></label>
      <label>Category<select name="category" required>
        ${["Electronics", "Construction", "Fashion", "Vehicles", "Kitchen", "Events", "Camping", "Furniture", "Cleaning", "Sports", "Other"].map(category => `<option>${category}</option>`).join("")}
      </select></label>
      <label>Daily price (Rs.)<input name="price" type="number" min="1" max="10000000" step="1" required></label>
      <label>Pickup location<input name="location" maxlength="120" placeholder="e.g. Patan, Lalitpur" required></label>
      <label>Image URL (optional)<input name="image" type="url" placeholder="https://..."></label>
      <label>Description<textarea name="description" minlength="10" maxlength="2000" required></textarea></label>
      <button class="auth-submit" type="submit">Publish listing</button>
    </form>`);
  $("#listingForm").addEventListener("submit", async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    values.price = Number(values.price);
    try {
      await api("/api/items", { method: "POST", body: JSON.stringify(values) });
      closeModal();
      await loadListings();
      notify("Your item is now listed.");
    } catch (error) {
      notify(error.message, true);
    }
  });
}

function openReserve(itemId) {
  const item = state.listings.find(listing => String(listing.id) === String(itemId));
  if (!item) return notify("This item is no longer available.", true);
  if (item.ownerId === state.user?.id) return notify("You cannot book your own item.", true);
  openModal(`
    <h2 id="modalTitle">Reserve ${escapeHTML(item.name)}</h2>
    <p class="muted">Send a booking request to ${escapeHTML(item.ownerName)}. The owner must approve it.</p>
    <div class="booking-summary">
      <div class="booking-row"><span>Daily price</span><strong>${formatPrice(item.price)}</strong></div>
      <div class="booking-row"><span>Owner</span><strong>${escapeHTML(item.ownerName)}</strong></div>
      <div class="booking-row"><span>Pickup</span><strong>${escapeHTML(item.location)}</strong></div>
    </div>
    <form id="reserveForm" class="modal-form">
      <label>Start date<input name="startDate" type="date" min="${todayString()}" required></label>
      <label>Number of days<input name="durationDays" type="number" min="1" max="30" value="1" required></label>
      <label>Pickup location<input name="pickupLocation" value="${escapeHTML(item.location)}" maxlength="120" required></label>
      <p class="muted">Total: <strong id="bookingTotal">${formatPrice(item.price)}</strong>. Payment is handled offline.</p>
      <button type="submit" class="auth-submit">Send booking request</button>
    </form>`);
  const form = $("#reserveForm");
  const daysInput = form.elements.durationDays;
  daysInput.addEventListener("input", () => {
    const days = Math.min(30, Math.max(1, Number(daysInput.value) || 1));
    $("#bookingTotal").textContent = formatPrice(item.price * days);
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    values.itemId = item.id;
    values.durationDays = Number(values.durationDays);
    try {
      await api("/api/bookings", { method: "POST", body: JSON.stringify(values) });
      closeModal();
      notify("Booking request sent. Check My bookings for updates.");
    } catch (error) {
      notify(error.message, true);
    }
  });
}

function bookingActions(booking, ownerView) {
  const buttons = [];
  if (ownerView && booking.status === "pending") {
    buttons.push(`<button class="auth-submit booking-action" data-id="${booking.id}" data-action="approve">Approve</button>`);
    buttons.push(`<button class="booking-secondary booking-action" data-id="${booking.id}" data-action="decline">Decline</button>`);
  }
  if (!ownerView && (booking.status === "pending" ||
    (booking.status === "approved" && booking.paymentStatus === "pending"))) {
    buttons.push(`<button class="booking-secondary booking-action" data-id="${booking.id}" data-action="cancel">Cancel booking</button>`);
  }
  if (!ownerView && booking.status === "approved" && booking.paymentStatus === "pending") {
    buttons.push(`<button class="booking-action booking-secondary" data-id="${booking.id}" data-action="report-payment">Report offline payment</button>`);
  }
  if (ownerView && booking.paymentStatus === "reported") {
    buttons.push(`<button class="auth-submit booking-action" data-id="${booking.id}" data-action="confirm-payment">Confirm payment</button>`);
  }
  if (ownerView && booking.status === "approved" && booking.endDate <= todayString()) {
    buttons.push(`<button class="booking-secondary booking-action" data-id="${booking.id}" data-action="complete">Mark returned</button>`);
  }
  return buttons.join("");
}

function bookingCard(booking, ownerView) {
  const status = booking.status[0].toUpperCase() + booking.status.slice(1);
  const payment = booking.paymentStatus === "reported"
    ? `Reported (${escapeHTML(booking.paymentMethod || "offline")})`
    : booking.paymentStatus[0].toUpperCase() + booking.paymentStatus.slice(1);
  return `<article class="booking-card">
    <div class="booking-card-heading"><div><h3>${escapeHTML(booking.itemName)}</h3>
      <p class="muted">${ownerView ? `Renter: ${escapeHTML(booking.renterName)} · ${escapeHTML(booking.renterEmail)}` : `Owner: ${escapeHTML(booking.ownerName)}`}</p></div>
      <span class="booking-status status-${booking.status}">${status}</span></div>
    <div class="booking-summary">
      <div class="booking-row"><span>Dates</span><strong>${formatDate(booking.startDate)} – ${formatDate(booking.endDate)}</strong></div>
      <div class="booking-row"><span>Pickup</span><strong>${escapeHTML(booking.pickupLocation)}</strong></div>
      <div class="booking-row"><span>Total</span><strong>${formatPrice(booking.totalPrice)}</strong></div>
      <div class="booking-row"><span>Offline payment</span><strong>${payment}</strong></div>
    </div>
    <div class="booking-actions">${bookingActions(booking, ownerView)}</div>
  </article>`;
}

async function openBookings() {
  openModal(`<h2 id="modalTitle">My bookings</h2><div class="booking-loading">Loading bookings…</div>`);
  try {
    const result = await api("/api/bookings");
    const asRenter = result.bookings.filter(booking => booking.isRenter);
    const asOwner = result.bookings.filter(booking => !booking.isRenter);
    $("#modalContent").innerHTML = `
      <h2 id="modalTitle">My bookings</h2>
      <h3 class="booking-section-title">Items I’m renting (${asRenter.length})</h3>
      ${asRenter.length ? asRenter.map(booking => bookingCard(booking, false)).join("") : '<p class="muted">You have not requested a rental yet.</p>'}
      <h3 class="booking-section-title">Requests for my items (${asOwner.length})</h3>
      ${asOwner.length ? asOwner.map(booking => bookingCard(booking, true)).join("") : '<p class="muted">No renters have requested your items yet.</p>'}`;
  } catch (error) {
    $("#modalContent").innerHTML = `<h2 id="modalTitle">My bookings</h2><p class="error-copy">${escapeHTML(error.message)}</p>`;
    return;
  }
}

async function handleBookingAction(button) {
  const id = button.dataset.id;
  const action = button.dataset.action;
  let method = "PATCH";
  let body = { action };
  if (action === "report-payment") {
    openModal(`<h2 id="modalTitle">Report offline payment</h2>
      <p class="muted">Select the method you used. This does not transfer money; the owner must confirm receipt.</p>
      <form id="paymentReportForm" class="modal-form">
        <label>Payment method<select name="method" required>
          <option value="Cash">Cash</option>
          <option value="Bank transfer">Bank transfer</option>
          <option value="Mobile wallet">Mobile wallet</option>
        </select></label>
        <button class="auth-submit" type="submit">Report payment</button>
      </form>`);
    $("#paymentReportForm").addEventListener("submit", async event => {
      event.preventDefault();
      const paymentMethod = new FormData(event.currentTarget).get("method");
      try {
        await api(`/api/bookings/${encodeURIComponent(id)}`, {
          method, body: JSON.stringify({ action, method: paymentMethod })
        });
        await openBookings();
        notify("Payment reported. The owner can confirm receipt.");
      } catch (error) {
        notify(error.message, true);
      }
    });
    return;
  }
  button.disabled = true;
  try {
    await api(`/api/bookings/${encodeURIComponent(id)}`, { method, body: JSON.stringify(body) });
    await openBookings();
    notify(action === "report-payment" ? "Payment reported. The owner can confirm receipt." : "Booking updated.");
  } catch (error) {
    button.disabled = false;
    notify(error.message, true);
  }
}

function showAccount() {
  if (!state.user) {
    showAuth();
    return;
  }
  openModal(`<h2 id="modalTitle">My account</h2>
    <div class="account-details">
      <p><span>Name</span><strong>${escapeHTML(state.user.name)}</strong></p>
      <p><span>Email</span><strong>${escapeHTML(state.user.email)}</strong></p>
      <p><span>Phone</span><strong>${escapeHTML(state.user.phone)}</strong></p>
    </div>
    <p class="muted">Your account can be used to rent items and publish your own listings.</p>
    <button type="button" class="auth-submit account-bookings" id="accountBookingsBtn">View my bookings</button>`);
  $("#accountBookingsBtn").addEventListener("click", openBookings);
}

function showInfo(title, copy) {
  openModal(`<h2 id="modalTitle">${escapeHTML(title)}</h2><p class="muted">${escapeHTML(copy)}</p><button type="button" class="auth-submit" id="infoCloseBtn">Close</button>`);
  $("#infoCloseBtn").addEventListener("click", closeModal);
}

async function registerUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.confirmPassword) return notify("Passwords do not match.", true);
  try {
    const result = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({ name: values.name, email: values.email, phone: values.phone, password: values.password })
    });
    state.user = result.user;
    form.reset();
    showApp();
    notify(`Welcome to Rentify, ${state.user.name}!`);
  } catch (error) {
    notify(error.message, true);
  }
}

async function loginUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: values.email, password: values.password, remember: values.remember === "on" })
    });
    state.user = result.user;
    form.reset();
    showApp();
    notify(`Welcome back, ${state.user.name}!`);
  } catch (error) {
    notify(error.message, true);
  }
}

async function logoutUser() {
  try {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    closeModal();
    updateUserInterface();
    showAuth();
    notify("You have been logged out.");
  } catch (error) {
    notify(error.message, true);
  }
}

function bindEvents() {
  $all("[data-auth]").forEach(button => button.addEventListener("click", () => {
    button.dataset.auth === "register" ? showRegisterForm() : showLoginForm();
  }));
  $all("[data-switch]").forEach(button => button.addEventListener("click", () => {
    button.dataset.switch === "register" ? showRegisterForm() : showLoginForm();
  }));
  $("#loginForm").addEventListener("submit", loginUser);
  $("#registerForm").addEventListener("submit", registerUser);
  $("#logoutBtn").addEventListener("click", logoutUser);
  $("#accountBtn").addEventListener("click", showAccount);
  $("#bookingsBtn").addEventListener("click", () => state.user ? openBookings() : showAuth());
  $("#listItemBtn").addEventListener("click", () => state.user ? itemListingForm() : showAuth(true));
  $("#modalClose").addEventListener("click", closeModal);
  $("#modalBackdrop").addEventListener("click", event => {
    if (event.target === $("#modalBackdrop")) closeModal();
  });
  $("#modalContent").addEventListener("click", event => {
    const button = event.target.closest(".booking-action");
    if (button) handleBookingAction(button);
  });
  $("#productGrid").addEventListener("click", event => {
    const button = event.target.closest(".reserve-btn");
    if (!button) return;
    if (!state.user) return showAuth();
    openReserve(button.dataset.itemId);
  });
  $("#searchForm").addEventListener("submit", event => {
    event.preventDefault();
    state.search = $("#searchInput").value;
    renderListings();
  });
  $("#searchInput").addEventListener("input", event => {
    state.search = event.target.value;
    renderListings();
  });
  $("#sortSelect").addEventListener("change", event => {
    state.sort = event.target.value;
    renderListings();
  });
  $("#durationSelect").addEventListener("change", event => {
    state.duration = event.target.value;
    $all("[data-filter]").forEach(button => {
      button.classList.toggle("active", button.dataset.filter === state.duration);
    });
    renderListings();
  });
  $("#resetBtn").addEventListener("click", () => {
    state.category = "All";
    state.search = "";
    state.duration = "all";
    state.sort = "recommended";
    $("#searchInput").value = "";
    $("#durationSelect").value = "all";
    $("#sortSelect").value = "recommended";
    $all("[data-filter]").forEach(button => button.classList.toggle("active", button.dataset.filter === "all"));
    renderCategories();
    renderListings();
  });
  $all("[data-category]").forEach(button => button.addEventListener("click", () => {
    state.category = button.dataset.category || "All";
    renderCategories();
    renderListings();
    $("#rentals").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $all("[data-filter]").forEach(button => button.addEventListener("click", () => {
    state.duration = button.dataset.filter || "all";
    $all("[data-filter]").forEach(filter => filter.classList.toggle("active", filter === button));
    renderListings();
  }));
  $all("[data-nav]").forEach(button => button.addEventListener("click", () => {
    const target = button.dataset.nav;
    if (target === "bookings") return state.user ? openBookings() : showAuth();
    if (target === "account") return showAccount();
    const element = target === "categories" ? $(".categories-section") : $(".search-panel");
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("#forgotBtn").addEventListener("click", () => showInfo("Password reset", "Password reset is not configured in this local version. Contact the site administrator to reset an account."));
  $("#termsBtn").addEventListener("click", () => showInfo("Terms and Conditions", "Rentify connects renters and item owners. Owners must provide accurate listings; renters must return items as agreed. Payment is arranged directly between the renter and owner."));
  $("#privacyBtn").addEventListener("click", () => showInfo("Privacy Policy", "Account details, listings, and booking records are stored in this local app database. Do not use real personal or payment data in a public deployment until privacy and security controls are configured."));
  $("#helpBtn").addEventListener("click", () => showInfo("Rentify assistance", "For a booking, open My bookings to check its status. Contact the item owner directly to coordinate pickup and offline payment."));
}

async function initialize() {
  bindEvents();
  try {
    const result = await api("/api/me");
    state.user = result.user;
    if (state.user) showApp();
    else showAuth();
  } catch (error) {
    showAuth();
    notify(`Could not connect to Rentify: ${error.message}. Start the server with npm start.`, true);
  }
}

initialize();
