// Confirm admin-review form submissions. Kept minimal; CSP forbids
// inline handlers so this picks up every form with data-confirm.
(function () {
  var forms = document.querySelectorAll("form[data-confirm]");
  for (var i = 0; i < forms.length; i++) {
    forms[i].addEventListener("submit", function (e) {
      var msg = e.currentTarget.getAttribute("data-confirm");
      if (msg && !window.confirm(msg)) {
        e.preventDefault();
      }
    });
  }
})();
