/// <reference lib="dom" />
// Admin review-notes island. Adds Google-Docs-style click-to-comment
// behavior to /admin/review/:id:
//
//  - Hover a [data-anchor-id] element in the brief → "+ comment"
//    affordance appears at its right edge.
//  - Click the affordance (or the element) → the form's anchor_key
//    hidden input gets that anchor, the "commenting on" indicator
//    updates with a snippet of the target text, and the textarea
//    receives focus.
//  - Click a sidebar group heading (data-jump-anchor) → scrolls the
//    brief to the anchored element, briefly flashes the background.
//  - Click "clear" in the indicator → switches back to general.
//
// All state lives in the form; HTMX handles persistence.

const ANCHOR_SELECTOR = "[data-anchor-id]";
const FORM_SELECTOR = "form.annot-form";
const FLASH_CLASS = "anchor-flash";
const SELECTED_CLASS = "anchor-selected";
const FLASH_DURATION_MS = 900;

function clearSelectedAnchor(): void {
  document
    .querySelectorAll<HTMLElement>(`.${SELECTED_CLASS}`)
    .forEach((el) => el.classList.remove(SELECTED_CLASS));
}

function markSelectedAnchor(key: string): void {
  clearSelectedAnchor();
  const target = document.querySelector<HTMLElement>(
    `${ANCHOR_SELECTOR}[data-anchor-id="${cssEscape(key)}"]`,
  );
  if (target !== null) target.classList.add(SELECTED_CLASS);
}

function setupAnchorClicks(): void {
  const form = document.querySelector<HTMLFormElement>(FORM_SELECTOR);
  if (form === null) return;
  const anchorInput = form.querySelector<HTMLInputElement>(
    'input[name="anchor_key"]',
  );
  const indicator = form.querySelector<HTMLElement>(".annot-target");
  const indicatorText =
    indicator?.querySelector<HTMLElement>(".target-text") ?? null;
  const clearBtn = form.querySelector<HTMLButtonElement>("[data-clear-anchor]");
  const textarea = form.querySelector<HTMLTextAreaElement>(
    'textarea[name="body"]',
  );
  if (
    anchorInput === null ||
    indicator === null ||
    indicatorText === null ||
    textarea === null
  ) {
    return;
  }

  const setAnchor = (key: string | null, snippet: string | null): void => {
    anchorInput.value = key ?? "";
    if (key === null) {
      indicator.classList.remove("has-anchor");
      indicatorText.textContent = "General comment";
      clearSelectedAnchor();
    } else {
      indicator.classList.add("has-anchor");
      indicatorText.textContent = snippet ?? key;
      markSelectedAnchor(key);
    }
  };

  // Click on any [data-anchor-id] in the brief preview → set anchor +
  // focus textarea. Use event delegation on the brief container.
  const brief = document.querySelector<HTMLElement>(".draft-preview");
  if (brief !== null) {
    brief.addEventListener("click", (ev) => {
      const el = (ev.target as Element | null)?.closest<HTMLElement>(
        ANCHOR_SELECTOR,
      );
      if (el === null || el === undefined) return;
      // Don't hijack actual link clicks inside the brief.
      if ((ev.target as Element | null)?.closest("a") !== null) return;
      ev.preventDefault();
      const key = el.getAttribute("data-anchor-id");
      const snippet = (el.textContent ?? "").trim().slice(0, 80);
      if (key !== null) setAnchor(key, snippet);
      textarea.focus();
    });
    // Visual hover affordance — tints the anchor element on hover so
    // it's discoverable without a separate "+ comment" button.
    brief.addEventListener("mouseover", (ev) => {
      const el = (ev.target as Element | null)?.closest<HTMLElement>(
        ANCHOR_SELECTOR,
      );
      if (el !== null && el !== undefined) el.classList.add("anchor-hover");
    });
    brief.addEventListener("mouseout", (ev) => {
      const el = (ev.target as Element | null)?.closest<HTMLElement>(
        ANCHOR_SELECTOR,
      );
      if (el !== null && el !== undefined) el.classList.remove("anchor-hover");
    });
  }

  if (clearBtn !== null) {
    clearBtn.addEventListener("click", () => {
      setAnchor(null, null);
      textarea.focus();
    });
  }

  // After a successful HTMX submit the form is reset by the inline
  // hx-on handler in admin-review.tsx — mirror that by dropping the
  // sticky highlight too. Listening on the form scopes us to this
  // form's responses, not other HTMX traffic on the page.
  form.addEventListener("htmx:afterRequest", (ev) => {
    const detail = (ev as CustomEvent<{ successful?: boolean }>).detail;
    if (detail?.successful === true) {
      clearSelectedAnchor();
    }
  });

  // Sidebar group headings link back to their anchor — scroll the
  // brief to that element and briefly flash it.
  document.addEventListener("click", (ev) => {
    const link = (ev.target as Element | null)?.closest<HTMLElement>(
      "[data-jump-anchor]",
    );
    if (link === null || link === undefined) return;
    const key = link.getAttribute("data-jump-anchor");
    if (key === null) return;
    const target = document.querySelector<HTMLElement>(
      `${ANCHOR_SELECTOR}[data-anchor-id="${cssEscape(key)}"]`,
    );
    if (target === null) return;
    ev.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add(FLASH_CLASS);
    window.setTimeout(() => {
      target.classList.remove(FLASH_CLASS);
    }, FLASH_DURATION_MS);
  });
}

// Minimal CSS.escape polyfill — anchor keys contain `:` which needs
// escaping in attribute selectors.
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupAnchorClicks);
} else {
  setupAnchorClicks();
}
