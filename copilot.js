// copilot.js
// UI-complete AI Copilot panel. NOT wired to a model in Milestone 1 -- this
// is the interface only. Every reply is an explicit system notice, never a
// hard-coded "AI" answer, so nothing here can be mistaken for real analysis.
// Milestone 3 replaces the body of respond() with a real model call, using
// the same appendMessage/loading plumbing already built here.

const SUGGESTED_PROMPTS = [
  "What's the trend?",
  'Find support and resistance.',
  "Explain this like I'm a beginner.",
  'What would invalidate this setup?',
  'What indicators should I use?',
  'Summarize this chart.',
];

export function initCopilot({ getChartContext, getConnectionStatus }) {
  const panel = document.getElementById('copilot');
  const messagesEl = document.getElementById('copilot-messages');
  const promptsEl = document.getElementById('copilot-prompts');
  const form = document.getElementById('copilot-form');
  const input = document.getElementById('copilot-input');
  const clearBtn = document.getElementById('copilot-clear-btn');
  const openBtn = document.getElementById('copilot-open-btn');
  const closeBtn = document.getElementById('copilot-close-btn');

  function renderEmptyState() {
    messagesEl.innerHTML = '';
    const empty = document.createElement('p');
    empty.className = 'copilot-empty';
    empty.textContent = 'Ask about the chart, or try a suggested prompt below.';
    messagesEl.appendChild(empty);
  }

  function appendMessage(role, text, { error = false } = {}) {
    messagesEl.querySelector('.copilot-empty')?.remove();
    const el = document.createElement('div');
    if (role === 'user') {
      el.className = 'msg msg-user';
      el.textContent = text;
    } else {
      el.className = 'msg msg-system' + (error ? ' msg-error' : '');
      const tag = document.createElement('span');
      tag.className = 'msg-tag';
      tag.textContent = error ? '[ERROR]' : '[SYSTEM]';
      el.append(tag, document.createTextNode(text));
    }
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function appendLoading() {
    const el = document.createElement('div');
    el.className = 'msg-loading';
    el.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function respond(userText) {
    const loadingEl = appendLoading();
    const delay = 500 + Math.random() * 400;
    setTimeout(() => {
      loadingEl.remove();

      // This is a genuine, not simulated, error condition: if the market
      // data socket is down there really is no chart context to reason
      // about, so it's reported as such rather than papered over.
      if (getConnectionStatus() !== 'live') {
        appendMessage(
          'system',
          "Can't read the chart right now \u2014 the market data connection is down, so there's no context to analyze.",
          { error: true }
        );
        return;
      }

      const ctx = getChartContext();
      const ctxLine = ctx.symbol
        ? `${ctx.symbol} \u00b7 ${ctx.timeframe}m \u00b7 last price ${ctx.price ?? '\u2014'}`
        : 'no symbol loaded yet';
      appendMessage(
        'system',
        `Not connected to a model yet \u2014 Milestone 1 ships the interface only. Once Milestone 3 wires one in, "${userText}" would go out with live chart context (${ctxLine}).`
      );
    }, delay);
  }

  function handleSend(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    appendMessage('user', trimmed);
    input.value = '';
    respond(trimmed);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSend(input.value);
  });

  SUGGESTED_PROMPTS.forEach((prompt) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'prompt-chip';
    chip.textContent = prompt;
    chip.addEventListener('click', () => handleSend(prompt));
    promptsEl.appendChild(chip);
  });

  clearBtn.addEventListener('click', renderEmptyState);
  renderEmptyState();

  // --- Mobile bottom-sheet wiring ---
  // app.js strips the `popover` attribute at desktop widths, so these
  // handlers no-op there; the panel just sits inline in the grid instead.
  function isSheetMode() {
    return panel.hasAttribute('popover');
  }

  openBtn.addEventListener('click', () => {
    if (isSheetMode()) panel.showPopover();
  });
  closeBtn.addEventListener('click', () => {
    if (isSheetMode()) panel.hidePopover();
  });
  // popover="manual" disables the browser's automatic outside-click
  // dismissal (unlike popover="auto"), which is deliberate here: "auto"
  // would also close the sheet on a stray tap while scrolling the message
  // list. Light-dismiss is re-implemented manually instead.
  panel.addEventListener('click', (e) => {
    if (isSheetMode() && e.target === panel) panel.hidePopover();
  });
  panel.addEventListener('toggle', (e) => {
    openBtn.setAttribute('aria-expanded', String(e.newState === 'open'));
  });
}
