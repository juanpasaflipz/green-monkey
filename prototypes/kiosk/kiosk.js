/* global document, window */
// Isolated design prototype: synthetic catalog and explicit payment simulation.
// No provider SDKs, backend requests, customer storage, or actual order submission.
const products = [
  {
    id: 0,
    name: "Pollo al limón",
    price: 18500,
    category: "bowls",
    description: "Pollo a la parrilla, quinoa, aguacate y limón rostizado.",
  },
  {
    id: 1,
    name: "Bowl de temporada",
    price: 16500,
    category: "bowls",
    description: "Camote rostizado, garbanzos, aguacate y tahini.",
  },
  {
    id: 2,
    name: "Res al grill",
    price: 21500,
    category: "bowls",
    description: "Res a la parrilla, papas doradas y chimichurri.",
  },
  {
    id: 3,
    name: "Ensalada de la casa",
    price: 15500,
    category: "salads",
    description: "Hojas frescas, aguacate, queso de cabra y semillas.",
  },
];
const $ = (selector) => document.querySelector(selector);
const money = (cents) =>
  new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 0,
  }).format(cents / 100);
let lines = [],
  service = "here",
  category = "all",
  screen = "menu",
  selected = 0,
  editing = null,
  pickupName = "",
  payment = "waiting";
const total = () =>
  lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label, action, className = "") {
  const node = element("button", className, label);
  node.type = "button";
  node.onclick = action;
  return node;
}
function renderProducts() {
  $("#products").replaceChildren();
  for (const product of products.filter(
    (p) => category === "all" || p.category === category,
  )) {
    const node = button("", () => openProduct(product.id), "product");
    node.setAttribute(
      "aria-label",
      `${product.name}, ${money(product.price)}, personalizar`,
    );
    const photo = element("div", `product-photo photo-${product.id}`);
    photo.setAttribute("aria-hidden", "true");
    const copy = element("span", "product-copy");
    copy.append(
      element("span", "product-name", product.name),
      element("span", "product-description", product.description),
    );
    const price = element("span", "product-price");
    price.append(
      element("strong", "", money(product.price)),
      element("span", "plus", "+"),
    );
    copy.append(price);
    node.append(photo, copy);
    $("#products").append(node);
  }
}
function lineNode(line, index) {
  const row = element("div", "line"),
    top = element("div", "line-top");
  top.append(
    element("span", "", `${line.quantity} × ${products[line.productId].name}`),
    element("span", "", money(line.price * line.quantity)),
  );
  row.append(
    top,
    element(
      "p",
      "",
      [
        line.base,
        line.extra ? "Extra de aguacate" : "",
        line.sauce ? "Aderezo aparte" : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
  const actions = element("div", "line-actions");
  const less = button("−", () => {
    if (line.quantity > 1) line.quantity--;
    else lines.splice(index, 1);
    renderCart();
  });
  less.setAttribute("aria-label", `Reducir ${products[line.productId].name}`);
  const more = button("+", () => {
    line.quantity++;
    renderCart();
  });
  more.disabled = line.quantity >= 20;
  more.setAttribute("aria-label", `Aumentar ${products[line.productId].name}`);
  actions.append(
    less,
    more,
    button("Editar", () => openProduct(line.productId, index)),
    button(
      "Quitar",
      () => {
        lines.splice(index, 1);
        renderCart();
      },
      "remove",
    ),
  );
  row.append(actions);
  return row;
}
function renderCart() {
  $("#cart-lines").replaceChildren();
  $("#review-lines").replaceChildren();
  if (!lines.length) {
    const empty = element("div", "empty");
    empty.append(
      element("span", "empty-mark", "↗"),
      element("strong", "", "Aquí empieza algo rico."),
      element("span", "", "Elige un plato y dale tu toque. Lo guardamos aquí."),
    );
    $("#cart-lines").append(empty);
  }
  lines.forEach((line, index) => {
    $("#cart-lines").append(lineNode(line, index));
    $("#review-lines").append(lineNode(line, index));
  });
  $("#cart-count").textContent = String(
    lines.reduce((sum, line) => sum + line.quantity, 0),
  );
  $("#cart-total").textContent = $("#review-total").textContent =
    money(total());
  $("#review-button").disabled = $("#pay-button").disabled = !lines.length;
  $("#pay-button").textContent = `Pagar ${money(total())} →`;
  document.querySelectorAll(".service-label").forEach((node) => {
    node.textContent = service === "here" ? "Comer aquí" : "Para llevar";
  });
}
function openProduct(id, index = null) {
  selected = id;
  editing = index;
  const product = products[id],
    line = index === null ? null : lines[index];
  $("#product-form").reset();
  $("#product-title").textContent = product.name;
  $("#product-description").textContent = product.description;
  $("#product-photo").className = `product-photo photo-${id}`;
  $("#base-field").hidden = product.category === "salads";
  if (line) {
    if (line.base) $(`input[name=base][value="${line.base}"]`).checked = true;
    $("input[name=extra]").checked = line.extra;
    $("input[name=sauce]").checked = line.sauce;
  }
  updateAdd();
  $("#product-dialog").showModal();
}
function unitPrice() {
  return products[selected].price + ($("input[name=extra]").checked ? 3000 : 0);
}
function updateAdd() {
  $("#add-button").textContent =
    `${editing === null ? "Agregar al pedido" : "Guardar cambios"} · ${money(unitPrice())}`;
}
$("#product-form").onchange = updateAdd;
$("#product-form").onsubmit = (event) => {
  event.preventDefault();
  const line = {
    productId: selected,
    price: unitPrice(),
    base:
      products[selected].category === "salads"
        ? ""
        : $("input[name=base]:checked").value,
    extra: $("input[name=extra]").checked,
    sauce: $("input[name=sauce]").checked,
    quantity: editing === null ? 1 : lines[editing].quantity,
  };
  if (editing === null) lines.push(line);
  else lines[editing] = line;
  $("#product-dialog").close();
  renderCart();
  $("#announcement").textContent =
    `${products[selected].name}: pedido actualizado. Total ${money(total())}.`;
};
$("#close-product").onclick = () => $("#product-dialog").close();
function showScreen(next) {
  closeNameKeyboard();
  screen = next;
  ["menu", "review", "payment"].forEach((name) => {
    $(`#${name}-screen`).hidden = name !== screen;
    const step = $(`[data-step=${name}]`);
    if (name === screen) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
  const locked = next === "payment";
  document.querySelectorAll("[data-service]").forEach((node) => {
    node.disabled = locked;
  });
  $("#restart-button").hidden = locked;
  $("#simulation").hidden = !locked || payment === "paid";
  if (locked) renderPayment();
  const heading = $(`#${next}-screen h1`);
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0 });
}
function renderPayment() {
  const pane = $("#payment-screen");
  pane.replaceChildren();
  if (payment === "paid") {
    pane.append(
      element("div", "success-mark", "✓"),
      element("p", "eyebrow", "PAGO CONFIRMADO · DEMOSTRACIÓN"),
      element(
        "h1",
        "",
        pickupName ? `¡Listo, ${pickupName}!` : "¡Buen provecho!",
      ),
      element("p", "", "Este sería tu número de pedido"),
      element("div", "order-number", "GM–024"),
      element(
        "p",
        "",
        pickupName
          ? `Te llamaremos por ${pickupName} cuando esté listo. También puedes identificar tu pedido con este número.`
          : "Te llamaremos por tu número cuando esté listo.",
      ),
      button("Empezar un nuevo pedido →", reset, "primary"),
    );
    $("#simulation").hidden = true;
    return;
  }
  const stopped = payment === "declined" || payment === "cancelled";
  const headline =
    payment === "unknown"
      ? "Estamos confirmando tu pago."
      : stopped
        ? payment === "declined"
          ? "Probemos de nuevo."
          : "Pago cancelado."
        : "Paga en la terminal a tu lado.";
  pane.append(
    element("p", "eyebrow", "UN PASO MÁS Y LISTO"),
    element("div", "payment-amount", money(total())),
    element("h1", "", headline),
  );
  if (pickupName)
    pane.append(
      element("p", "pickup-summary", `Pedido a nombre de ${pickupName}`),
    );
  if (!stopped) {
    const terminal = element("div", "terminal");
    terminal.setAttribute("aria-hidden", "true");
    const display = element("div", "terminal-screen");
    display.append(
      element("span", "", ")))"),
      element("b", "", money(total())),
    );
    const keys = element("div", "terminal-keys");
    for (let i = 0; i < 9; i++) keys.append(element("i", ""));
    terminal.append(display, keys);
    pane.append(terminal);
  }
  pane.append(
    element(
      "p",
      "",
      payment === "unknown"
        ? "No vuelvas a pagar. Tu pedido está guardado mientras confirmamos el resultado."
        : stopped
          ? "Tu pedido sigue aquí. Puedes volver a intentarlo o revisarlo."
          : "Acerca o inserta tu tarjeta en la terminal.",
    ),
    element(
      "div",
      "status-pill",
      payment === "unknown"
        ? "Confirmación pendiente"
        : stopped
          ? "No se completó el pago"
          : "Esperando tu pago…",
    ),
  );
  if (stopped)
    pane.append(
      button(
        "Reintentar pago →",
        () => {
          payment = "waiting";
          renderPayment();
        },
        "primary",
      ),
      button("Volver a mi pedido", () => showScreen("review"), "text-button"),
    );
  pane.append(
    element(
      "p",
      "fine",
      "Demostración: no se envían pedidos ni se realizan cobros.",
    ),
  );
}
function message(title, text, confirmLabel, action, cancel = true) {
  $("#message-title").textContent = title;
  $("#message-text").textContent = text;
  $("#message-confirm").textContent = confirmLabel;
  $("#message-cancel").hidden = !cancel;
  $("#message-confirm").onclick = () => {
    $("#message-dialog").close();
    action?.();
  };
  $("#message-dialog").showModal();
}
function reset() {
  lines = [];
  category = "all";
  service = "here";
  payment = "waiting";
  pickupName = "";
  $("#pickup-name").value = "";
  document
    .querySelectorAll("[data-category]")
    .forEach((n) =>
      n.setAttribute("aria-pressed", String(n.dataset.category === category)),
    );
  document
    .querySelectorAll("[data-service]")
    .forEach((n) =>
      n.setAttribute("aria-pressed", String(n.dataset.service === service)),
    );
  renderProducts();
  renderCart();
  showScreen("menu");
}
document.querySelectorAll("[data-category]").forEach((node) => {
  node.onclick = () => {
    category = node.dataset.category;
    document
      .querySelectorAll("[data-category]")
      .forEach((n) => n.setAttribute("aria-pressed", String(n === node)));
    renderProducts();
  };
});
document.querySelectorAll("[data-service]").forEach((node) => {
  node.onclick = () => {
    service = node.dataset.service;
    document
      .querySelectorAll("[data-service]")
      .forEach((n) => n.setAttribute("aria-pressed", String(n === node)));
    renderCart();
  };
});
document.querySelectorAll("[data-outcome]").forEach((node) => {
  node.onclick = () => {
    if (screen !== "payment" || payment === "paid") return;
    payment = node.dataset.outcome;
    renderPayment();
  };
});
$("#review-button").onclick = () => {
  renderCart();
  showScreen("review");
};
$("#back-menu").onclick = () => showScreen("menu");
$("#pay-button").onclick = () => {
  if (!lines.length) return;
  pickupName = $("#pickup-name").value.trim().replace(/\s+/g, " ");
  $("#pickup-name").value = pickupName;
  payment = "waiting";
  showScreen("payment");
};
$("#restart-button").onclick = () =>
  lines.length
    ? message(
        "¿Empezamos de nuevo?",
        "Se quitarán los productos de este pedido.",
        "Sí, empezar de nuevo",
        reset,
      )
    : reset();
$("#help-button").onclick = () =>
  message(
    "Estamos para ayudarte.",
    "Acércate al equipo del restaurante si necesitas ayuda con ingredientes o con la terminal. Este prototipo no envía una solicitud al personal.",
    "Entendido",
    null,
    false,
  );
$("#message-cancel").onclick = () => $("#message-dialog").close();
// In-page keyboard keeps all three steps intact and works on kiosk browsers
// without an OS touch keyboard. Physical typing and caret selection still work.
function closeNameKeyboard() {
  $("#name-keyboard").hidden = true;
  $("#pickup-name").setAttribute("aria-expanded", "false");
}
const nameInput = $("#pickup-name");
nameInput.onfocus = () => {
  $("#name-keyboard").hidden = false;
  nameInput.setAttribute("aria-expanded", "true");
  $(".pickup-name").scrollIntoView({ block: "start" });
};
nameInput.oninput = () => {
  pickupName = nameInput.value;
};
function typeName(text, erase = false) {
  const start = nameInput.selectionStart ?? nameInput.value.length;
  const end = nameInput.selectionEnd ?? start;
  const from = erase && start === end ? Math.max(0, start - 1) : start;
  const next =
    nameInput.value.slice(0, from) + text + nameInput.value.slice(end);
  if (next.length > nameInput.maxLength) return;
  nameInput.value = next;
  pickupName = next;
  nameInput.focus({ preventScroll: true });
  nameInput.setSelectionRange(from + text.length, from + text.length);
}
for (const letter of "QWERTYUIOPASDFGHJKLÑZXCVBNMÁÉÍÓÚÜ") {
  const key = button(letter, () => {
    const start = nameInput.selectionStart ?? nameInput.value.length;
    const capital = start === 0 || nameInput.value[start - 1] === " ";
    typeName(capital ? letter : letter.toLocaleLowerCase("es"));
  });
  key.setAttribute("aria-label", `Escribir ${letter}`);
  $("#name-keys").append(key);
}
$("#name-keyboard").onpointerdown = (event) => {
  if (event.target.closest("button")) event.preventDefault();
};
$("#name-space").onclick = () => typeName(" ");
$("#name-delete").onclick = () => typeName("", true);
$("#name-done").onclick = () => {
  closeNameKeyboard();
  $("#pay-button").focus();
};
nameInput.onkeydown = (event) => {
  if (event.key === "Enter" || event.key === "Escape") {
    event.preventDefault();
    closeNameKeyboard();
    $("#pay-button").focus();
  }
};
renderProducts();
renderCart();
