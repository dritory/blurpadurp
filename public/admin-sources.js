// /admin/sources bulk-block helpers. Plain JS, no framework.
//
//  - Toggle "select all" checks/unchecks every row checkbox in the
//    hosts-seen table.
//  - The "Block selected (N)" button reflects the live count and stays
//    disabled while N=0 so a stray click doesn't submit an empty form
//    (server already rejects, but the UX is nicer this way).
(function () {
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  var rowBoxes = $$("[data-bulk-row]");
  var toggle = $("[data-bulk-toggle]");
  var count = $("[data-bulk-count]");
  var submit = $("[data-bulk-submit]");
  if (rowBoxes.length === 0 || toggle === null || count === null || submit === null) {
    return;
  }

  function refresh() {
    var n = 0;
    for (var i = 0; i < rowBoxes.length; i++) {
      if (rowBoxes[i].checked) n++;
    }
    count.textContent = n + " selected";
    submit.disabled = n === 0;
    submit.textContent = n > 1 ? "Block selected (" + n + ")" : "Block selected";
    toggle.checked = n === rowBoxes.length;
    toggle.indeterminate = n > 0 && n < rowBoxes.length;
  }

  toggle.addEventListener("change", function () {
    for (var i = 0; i < rowBoxes.length; i++) {
      rowBoxes[i].checked = toggle.checked;
    }
    refresh();
  });
  for (var i = 0; i < rowBoxes.length; i++) {
    rowBoxes[i].addEventListener("change", refresh);
  }
  refresh();
})();
