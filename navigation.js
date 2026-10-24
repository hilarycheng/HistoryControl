/* global browser */
"use strict";

// Keep navigation local to Options; changing sections never reloads the page
// and never triggers a History cleanup or a settings write.
const sectionButtons = [...document.querySelectorAll("[data-section-target]")];
const sectionPanels = [...document.querySelectorAll("[data-history-section]")];
const navigation = document.getElementById("nav-items");
const navigationToggle = document.getElementById("nav-toggle");
const sectionMap = new Map(sectionPanels.map((panel) => [panel.dataset.historySection, panel]));

function setNavigationExpanded(expanded) {
  navigation.classList.toggle("is-open", expanded);
  navigationToggle.setAttribute("aria-expanded", String(expanded));
}

function showSection(section, fromNavigation = false) {
  const target = sectionMap.get(section);
  if (!target) return;
  for (const panel of sectionPanels) panel.hidden = panel !== target;
  for (const button of sectionButtons) {
    const selected = button.dataset.sectionTarget === section;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  // Collapse only on mobile. Focus remains visible on the toggle button.
  if (window.matchMedia("(max-width: 850px)").matches) {
    setNavigationExpanded(false);
    if (fromNavigation) navigationToggle.focus();
  }
}

for (const button of sectionButtons) {
  button.addEventListener("click", () => showSection(button.dataset.sectionTarget, true));
}
navigationToggle.addEventListener("click", () => {
  setNavigationExpanded(navigationToggle.getAttribute("aria-expanded") !== "true");
});

showSection("overview");
