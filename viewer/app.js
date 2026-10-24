const summaryEl = document.querySelector("#summary");
const sampleEl = document.querySelector("#sample");
const fileEl = document.querySelector("#file");
const filtersEl = document.querySelector("#filters");
const opsEl = document.querySelector("#ops");
const leftPane = document.querySelector("#left-pane");
const rightPane = document.querySelector("#right-pane");

const state = {
  report: null,
  filter: "all",
  selected: 0,
  formatting: false,
  files: { left: "", right: "" },
};

const KIND_LABEL = {
  rename: "Rename",
  move: "Move",
  "rename-move": "Rename + move",
  extract: "Extract",
  inline: "Inline",
  "signature-change": "Signature",
  reorder: "Reorder",
  "logic-edit": "Logic",
  add: "Add",
  remove: "Remove",
};

init();

async function init() {
  bind();
  const embedded = await fetchJson("/api/report.json");
  const index = (await fetchJson("./samples/index.json")) ?? [];
  fillSamples(index);
  if (embedded && !embedded.error) {
    setReport(embedded);
    return;
  }
  if (index[0]) await loadSample(sampleUrl(index[0].file));
  else summaryEl.textContent = "No sample reports found. Open a JSON report from the CLI.";
}

function bind() {
  sampleEl.addEventListener("change", () => {
    if (sampleEl.value) loadSample(sampleEl.value);
  });
  fileEl.addEventListener("change", async () => {
    const file = fileEl.files?.[0];
    if (!file) return;
    setReport(JSON.parse(await file.text()));
    sampleEl.value = "";
  });
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key !== "j" && event.key !== "k") return;
    const visible = visibleIndexes();
    if (!visible.length) return;
    const current = Math.max(0, visible.indexOf(state.selected));
    const next = event.key === "j" ? Math.min(visible.length - 1, current + 1) : Math.max(0, current - 1);
    state.formatting = false;
    state.selected = visible[next];
    render();
  });
}

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function fillSamples(index) {
  const groups = new Map();
  for (const entry of index) {
    const bucket = groups.get(entry.language) ?? [];
    bucket.push(entry);
    groups.set(entry.language, bucket);
  }
  sampleEl.replaceChildren();
  for (const [language, entries] of groups) {
    const group = document.createElement("optgroup");
    group.label = language;
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = sampleUrl(entry.file);
      option.textContent = entry.title;
      group.append(option);
    }
    sampleEl.append(group);
  }
}

function sampleUrl(file) {
  return file.startsWith("./samples/") ? file : `./samples/${file}`;
}

async function loadSample(file) {
  const report = await fetchJson(sampleUrl(file));
  if (report) setReport(report);
}

function setReport(report) {
  state.report = report;
  state.filter = "all";
  state.selected = 0;
  state.formatting = false;
  state.files = {
    left: firstFile(report, "left"),
    right: firstFile(report, "right"),
  };
  focusOperation(0);
  render();
}

function render() {
  const report = state.report;
  if (!report) return;
  summaryEl.textContent = report.summary;
  renderFilters(report);
  renderOps(report);
  renderPane(leftPane, "Before", "left", report);
  renderPane(rightPane, "After", "right", report);
}

function renderFilters(report) {
  const kinds = ["all", ...Object.keys(report.stats.byKind ?? {})];
  filtersEl.replaceChildren();
  for (const kind of kinds) {
    const button = document.createElement("button");
    button.type = "button";
    const count = kind === "all" ? report.operations.length : report.stats.byKind[kind];
    button.textContent = `${kind === "all" ? "All" : KIND_LABEL[kind] ?? kind} ${count}`;
    button.setAttribute("aria-pressed", String(state.filter === kind));
    button.addEventListener("click", () => {
      state.filter = kind;
      state.formatting = false;
      const visible = visibleIndexes();
      state.selected = visible[0] ?? 0;
      focusOperation(state.selected);
      render();
    });
    filtersEl.append(button);
  }
}

function renderOps(report) {
  opsEl.replaceChildren();
  report.operations.forEach((operation, index) => {
    if (state.filter !== "all" && operation.kind !== state.filter) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `op${index === state.selected && !state.formatting ? " active" : ""}`;
    button.style.setProperty("--kind", kindColor(operation.kind));
    const title = document.createElement("p");
    title.textContent = report.summaryLines?.[index] ?? operation.kind;
    const meta = document.createElement("small");
    meta.textContent = `${KIND_LABEL[operation.kind] ?? operation.kind} · ${Math.round(operation.confidence * 100)}%`;
    button.append(title, meta);
    button.addEventListener("click", () => {
      state.formatting = false;
      state.selected = index;
      focusOperation(index);
      render();
    });
    opsEl.append(button);
  });
  if ((report.ignoredFormatting ?? []).length) {
    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = "Formatting ignored";
    opsEl.append(label);
    for (const entry of report.ignoredFormatting) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `quiet${state.formatting && state.files.left === entry.file ? " active" : ""}`;
      const title = document.createElement("p");
      title.textContent = entry.file;
      const meta = document.createElement("small");
      meta.textContent = entry.reason;
      button.append(title, meta);
      button.addEventListener("click", () => {
        state.formatting = true;
        state.files.left = entry.file;
        state.files.right = entry.file;
        render();
      });
      opsEl.append(button);
    }
  }
  if (!report.operations.length && !(report.ignoredFormatting ?? []).length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No semantic changes.";
    opsEl.append(empty);
  }
}

function renderPane(pane, title, side, report) {
  const files = Object.keys(report.sources?.[side] ?? {});
  pane.replaceChildren();
  const head = document.createElement("div");
  head.className = "pane-head";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const select = document.createElement("select");
  select.setAttribute("aria-label", `${title} file`);
  const options = files.length ? files : ["(no embedded source)"];
  for (const file of options) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file;
    if (file === state.files[side]) option.selected = true;
    select.append(option);
  }
  if (!files.includes(state.files[side]) && files[0]) state.files[side] = files[0];
  select.addEventListener("change", () => {
    state.files[side] = select.value;
    render();
  });
  head.append(heading, select);
  const code = document.createElement("pre");
  code.className = "code";
  const source = report.sources?.[side]?.[state.files[side]];
  if (source === undefined) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = files.length ? "This file is not on this side of the diff." : "This report has no embedded sources. Re-run without --no-sources.";
    code.append(empty);
  } else {
    const highlights = state.formatting
      ? []
      : (report.highlights ?? []).filter((highlight) => highlight.side === side && highlight.file === state.files[side] && highlight.opIndex === state.selected);
    const lines = source.split("\n");
    lines.forEach((text, index) => {
      const lineNo = index + 1;
      const hit = highlights.find((highlight) => covers(highlight.span, lineNo));
      const row = document.createElement("div");
      row.className = hit ? "line hit" : "line";
      if (hit) row.style.setProperty("--hit", kindColor(hit.kind));
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(lineNo);
      const src = document.createElement("span");
      src.className = "src";
      src.textContent = text.length ? text : " ";
      row.append(num, src);
      if (hit) row.dataset.hit = "1";
      code.append(row);
    });
  }
  pane.append(head, code);
  const hit = code.querySelector("[data-hit]");
  if (hit) code.scrollTop = Math.max(0, hit.offsetTop - code.clientHeight / 3);
}

function focusOperation(index) {
  const report = state.report;
  if (!report) return;
  const highlights = (report.highlights ?? []).filter((highlight) => highlight.opIndex === index);
  const left = highlights.find((highlight) => highlight.side === "left");
  const right = highlights.find((highlight) => highlight.side === "right");
  if (left) state.files.left = left.file;
  if (right) state.files.right = right.file;
}

function visibleIndexes() {
  if (!state.report) return [];
  return state.report.operations
    .map((operation, index) => ({ operation, index }))
    .filter(({ operation }) => state.filter === "all" || operation.kind === state.filter)
    .map(({ index }) => index);
}

function firstFile(report, side) {
  const highlighted = (report.highlights ?? []).find((highlight) => highlight.side === side);
  if (highlighted) return highlighted.file;
  return Object.keys(report.sources?.[side] ?? {})[0] ?? "";
}

function covers(span, line) {
  if (line < span.start.line || line > span.end.line) return false;
  if (line === span.end.line && span.end.column === 1 && line !== span.start.line) return false;
  return true;
}

function kindColor(kind) {
  return {
    rename: "#e0b15c",
    move: "#8eb8cc",
    "rename-move": "#e6d3ae",
    extract: "#9dcaa8",
    inline: "#c9d6a3",
    "signature-change": "#e6c2a2",
    reorder: "#c8c0b4",
    "logic-edit": "#e08a68",
    add: "#9dcaa8",
    remove: "#e08a68",
  }[kind] ?? "#c8c0b4";
}
