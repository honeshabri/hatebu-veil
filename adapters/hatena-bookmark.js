// Only site-specific selectors and extraction belong here.
const HatenaBookmarkAdapter = {
  site: "hatena-bookmark",
  selector: ".entry-comment-text.js-bookmark-comment",

  find(root = document) {
    const elements = [];
    if (root instanceof Element && root.matches(this.selector)) elements.push(root);
    if (root.querySelectorAll) elements.push(...root.querySelectorAll(this.selector));
    return elements;
  },

  extract(element) {
    const container = element.closest(".entry-comment-contents");
    if (!container) return null;
    const text = element.textContent?.trim();
    if (!text) return null;
    const permalink = container.querySelector(".entry-comment-permalink a")?.getAttribute("href");
    const commentId = permalink?.match(/^\/entry\/\d+\/comment\/[^/?#]+/)?.[0] || null;
    const actionTarget = container.querySelector(".entry-comment-menus") ||
      container.querySelector(".entry-comment-contents-foot") || container;
    const actionBefore = actionTarget?.querySelector(".js-add-star-container") || null;
    return { element, text, commentId, actionTarget, actionBefore };
  }
};

globalThis.HatebuVeilAdapter = HatenaBookmarkAdapter;
