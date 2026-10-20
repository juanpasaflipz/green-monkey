/* global localStorage, document */
// Prototype-only persistence. Production must load/publish a tenant-scoped,
// owner-authorized configuration; never use this browser key as tenant identity.
(() => {
  const palettes = {
    forest: {
      label: "Bosque",
      description: "Verde profundo · Marfil · Lima",
      values: [
        "#164d35",
        "#183f2d",
        "#f7f5ec",
        "#fffdf6",
        "#eef0e5",
        "#e8ecdf",
        "#d8ddcf",
        "#5a685d",
        "#deeeaa",
        "#eae9df",
        "#246243",
        "#7b5907",
      ],
    },
    clay: {
      label: "Terracota",
      description: "Arcilla · Crema · Durazno",
      values: [
        "#873c2d",
        "#492b25",
        "#fbf4ec",
        "#fffaf4",
        "#f3e7dc",
        "#edddce",
        "#ddc9ba",
        "#70584d",
        "#f5d4b3",
        "#eae0d7",
        "#733024",
        "#704b00",
      ],
    },
    ocean: {
      label: "Océano",
      description: "Azul tinta · Perla · Cielo",
      values: [
        "#244d69",
        "#20394a",
        "#f3f6f7",
        "#ffffff",
        "#e6eef2",
        "#dce8ee",
        "#c8d7df",
        "#506572",
        "#cce8f5",
        "#e0e8ec",
        "#193c55",
        "#735000",
      ],
    },
    plum: {
      label: "Ciruela",
      description: "Ciruela · Lino · Rosa",
      values: [
        "#633c59",
        "#422c3c",
        "#faf4f6",
        "#fffafb",
        "#eee4eb",
        "#e8dce4",
        "#d8c6d2",
        "#6d5665",
        "#efd5e2",
        "#e9e0e5",
        "#512e48",
        "#745000",
      ],
    },
  };
  const tokens = [
    "green",
    "ink",
    "cream",
    "surface",
    "panel",
    "soft",
    "line",
    "muted",
    "lime",
    "canvas",
    "hover",
    "focus",
  ];
  const fonts = {
    signature: {
      heading: "Inter, Arial, sans-serif",
      accent: "Georgia, serif",
      style: "italic",
    },
    modern: {
      heading: "Inter, Arial, sans-serif",
      accent: "Inter, Arial, sans-serif",
      style: "normal",
    },
    editorial: {
      heading: "Georgia, serif",
      accent: "Georgia, serif",
      style: "italic",
    },
  };
  const key = "gm-kiosk-prototype-appearance-v1";
  const defaults = { palette: "forest", font: "signature" };
  const valid = (value) =>
    value &&
    Object.hasOwn(palettes, value.palette) &&
    Object.hasOwn(fonts, value.font);
  let saved = { ...defaults };
  try {
    const value = JSON.parse(localStorage.getItem(key));
    if (valid(value)) saved = { palette: value.palette, font: value.font };
  } catch {
    /* Storage is optional; keep the usable default. */
  }
  let draft = { ...saved };
  const $ = (selector) => document.querySelector(selector);
  const status = (text) => {
    $("#appearance-status").textContent = text;
  };
  function apply() {
    const style = document.documentElement.style;
    tokens.forEach((token, index) =>
      style.setProperty(`--${token}`, palettes[draft.palette].values[index]),
    );
    style.setProperty("--heading-font", fonts[draft.font].heading);
    style.setProperty("--accent-font", fonts[draft.font].accent);
    style.setProperty("--accent-style", fonts[draft.font].style);
    document.documentElement.dataset.palette = draft.palette;
    document.documentElement.dataset.font = draft.font;
    document.querySelector('meta[name="theme-color"]').content =
      palettes[draft.palette].values[0];
    document
      .querySelectorAll("input[name=appearance-palette]")
      .forEach((node) => {
        node.checked = node.value === draft.palette;
      });
    $("#appearance-font").value = draft.font;
  }
  for (const [id, palette] of Object.entries(palettes)) {
    const label = document.createElement("label");
    label.className = "palette-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "appearance-palette";
    radio.value = id;
    const swatches = document.createElement("span");
    swatches.className = "palette-swatches";
    swatches.setAttribute("aria-hidden", "true");
    for (const color of [
      palette.values[0],
      palette.values[2],
      palette.values[8],
    ]) {
      const dot = document.createElement("i");
      dot.style.background = color;
      swatches.append(dot);
    }
    const name = document.createElement("strong");
    name.textContent = palette.label;
    const description = document.createElement("small");
    description.textContent = palette.description;
    label.append(radio, swatches, name, description);
    $("#palette-options").append(label);
    radio.onchange = () => {
      draft.palette = id;
      apply();
      status("Vista previa sin guardar.");
    };
  }
  $("#appearance-font").onchange = (event) => {
    draft.font = event.target.value;
    apply();
    status("Vista previa sin guardar.");
  };
  function close() {
    $("#appearance-editor").hidden = true;
    $("#appearance-toggle").setAttribute("aria-expanded", "false");
    $("#appearance-toggle").focus();
  }
  function discard() {
    draft = { ...saved };
    apply();
    status("Cambios descartados. Se conserva el estilo guardado.");
  }
  $("#appearance-toggle").onclick = () => {
    if (!$("#appearance-editor").hidden) {
      discard();
      close();
      return;
    }
    draft = { ...saved };
    apply();
    $("#appearance-editor").hidden = false;
    $("#appearance-toggle").setAttribute("aria-expanded", "true");
    status("Prueba local: no publica cambios en la cuenta del restaurante.");
  };
  $("#appearance-close").onclick = () => {
    discard();
    close();
  };
  $("#appearance-cancel").onclick = discard;
  $("#appearance-reset").onclick = () => {
    draft = { ...defaults };
    apply();
    status("Estilo Green Monkey en vista previa. Guarda para conservarlo.");
  };
  $("#appearance-save").onclick = () => {
    try {
      localStorage.setItem(key, JSON.stringify(draft));
      saved = { ...draft };
      status(
        "Guardado en este navegador. No se ha publicado en la cuenta del restaurante.",
      );
    } catch {
      status(
        "No se pudo guardar en este navegador. La vista previa sigue disponible.",
      );
    }
  };
  apply();
})();
