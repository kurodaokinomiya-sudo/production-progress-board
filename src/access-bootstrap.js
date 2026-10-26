(() => {
  "use strict";

  async function open(html) {
    if (typeof html !== "string") throw new Error("application-unavailable");
    const page = new DOMParser().parseFromString(html, "text/html");
    if (!page.querySelector("#startup-loading") || !page.querySelector("#main-content")) throw new Error("application-unavailable");
    const scripts = [...page.querySelectorAll("script")];
    scripts.forEach((script) => script.remove());
    // Preserve the HtmlService transport and its window event listeners.
    // Replacing the document with document.write would remove those listeners.
    document.querySelectorAll("[data-access-shell]").forEach((element) => element.remove());
    for (const style of page.head.querySelectorAll("style, link[rel='stylesheet']")) {
      document.head.append(document.importNode(style, true));
    }
    document.title = page.title;
    document.documentElement.lang = page.documentElement.lang || "ja";
    document.documentElement.dataset.theme = page.documentElement.dataset.theme || "light";
    document.body.className = page.body.className;
    document.body.replaceChildren(...[...page.body.childNodes].map((node) => document.importNode(node, true)));
    for (const source of scripts) {
      const script = document.createElement("script");
      for (const attribute of source.attributes) script.setAttribute(attribute.name, attribute.value);
      script.textContent = source.textContent;
      if (source.hasAttribute("src") && source.type !== "module") {
        await new Promise((resolve) => {
          script.onload = resolve;
          script.onerror = resolve;
          document.body.append(script);
        });
      } else document.body.append(script); // PDF modules load independently, as on a normal page.
    }
  }

  globalThis.ProductionAppBootstrap = { open };
})();
