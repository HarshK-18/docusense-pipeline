/* DocuSense reviewer page: pending list, preview, editable fields, approve / reject.
   Plain JavaScript. Needs auth.js and api.js loaded first.
   The API enforces who may review; this page only decides what to show. */
(function () {
  "use strict";

  var LOW_CONFIDENCE = 80; // display hint only; the real threshold lives in the processor Lambda
  var FIELD_DEFS = [
    { key: "VENDOR_NAME", label: "Vendor" },
    { key: "INVOICE_RECEIPT_DATE", label: "Invoice date" },
    { key: "TOTAL", label: "Total" }
  ];

  var queue = [];
  var current = null;
  var busy = false;

  function el(id) { return document.getElementById(id); }

  function setMessage(id, text, kind) {
    var node = el(id);
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("is-error", kind === "error");
    node.classList.toggle("is-success", kind === "success");
  }

  function formatDate(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleString();
  }

  function formatScore(score) {
    return typeof score === "number" ? String(Math.round(score * 10) / 10) : "\u2014";
  }

  function setBusy(value) {
    busy = value;
    el("approve-btn").disabled = value;
    el("reject-btn").disabled = value;
  }

  /* ---------- queue ---------- */

  function renderQueue() {
    var list = el("queue-list");
    list.textContent = "";
    queue.forEach(function (doc) {
      var item = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "queue-item";
      if (current && current.docId === doc.docId) {
        button.classList.add("is-selected");
        button.setAttribute("aria-current", "true");
      }

      var name = document.createElement("span");
      name.className = "queue-name";
      name.textContent = doc.filename || "Unnamed document";

      var meta = document.createElement("span");
      meta.className = "queue-meta";
      var when = formatDate(doc.createdAt);
      meta.textContent = "Score " + formatScore(doc.score) + (when ? " \u00b7 " + when : "");

      button.appendChild(name);
      button.appendChild(meta);
      button.addEventListener("click", function () { selectDocument(doc.docId); });
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  function loadQueue(doneMessage) {
    var refresh = el("queue-refresh-btn");
    refresh.disabled = true;
    setMessage("queue-message", "Loading...", "");
    return window.DocuSenseApi.request("GET", "/review/pending")
      .then(function (data) {
        queue = Array.isArray(data.documents) ? data.documents : [];
        var stillThere = current && queue.some(function (d) { return d.docId === current.docId; });
        if (current && !stillThere) hideDetail();
        if (current && stillThere) {
          current = queue.filter(function (d) { return d.docId === current.docId; })[0];
          renderPreview(current);
        }
        renderQueue();
        if (doneMessage) setMessage("queue-message", doneMessage, "success");
        else if (!queue.length) setMessage("queue-message", "Nothing is waiting for review.", "");
        else setMessage("queue-message", "", "");
      })
      .catch(function (err) {
        if (err.status === 403) setMessage("queue-message", "Only reviewers can see this queue.", "error");
        else setMessage("queue-message", err.message || "Could not load the queue.", "error");
      })
      .then(function () { refresh.disabled = false; });
  }

  /* ---------- detail ---------- */

  function hideDetail() {
    current = null;
    el("detail-card").hidden = true;
    setMessage("detail-message", "", "");
  }

  function renderPreview(doc) {
    var box = el("preview");
    box.textContent = "";
    var url = doc.viewUrl;
    if (typeof url !== "string" || url.indexOf("https://") !== 0) {
      box.textContent = "Preview not available.";
      return;
    }
    var type = doc.contentType;
    if (type === "image/png" || type === "image/jpeg") {
      var img = document.createElement("img");
      img.src = url;
      img.alt = "Uploaded document preview";
      box.appendChild(img);
    } else if (type === "application/pdf") {
      var frame = document.createElement("iframe");
      frame.src = url;
      frame.title = "Uploaded document preview";
      frame.referrerPolicy = "no-referrer";
      box.appendChild(frame);
    }
    var link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "preview-link";
    link.textContent = "Open the document in a new tab";
    box.appendChild(link);
  }

  function renderFields(doc) {
    var wrap = el("fields-wrap");
    wrap.textContent = "";
    var fields = doc.fields || {};
    FIELD_DEFS.forEach(function (def) {
      var data = fields[def.key] || {};
      var row = document.createElement("div");
      row.className = "field";

      var label = document.createElement("label");
      label.htmlFor = "field-" + def.key;
      label.textContent = def.label;

      var input = document.createElement("input");
      input.type = "text";
      input.id = "field-" + def.key;
      input.maxLength = 200;
      input.autocomplete = "off";
      input.value = typeof data.value === "string" ? data.value : "";

      var hint = document.createElement("span");
      hint.className = "field-hint";
      var confidence = typeof data.confidence === "number" ? data.confidence : 0;
      if (data.value === null || data.value === undefined) {
        hint.textContent = "Not found by the system";
        hint.classList.add("is-low");
      } else {
        hint.textContent = "Confidence " + formatScore(confidence);
        if (confidence < LOW_CONFIDENCE) hint.classList.add("is-low");
      }

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(hint);
      wrap.appendChild(row);
    });
  }

  function selectDocument(docId) {
    var doc = queue.filter(function (d) { return d.docId === docId; })[0];
    if (!doc) return;
    current = doc;
    el("detail-card").hidden = false;
    el("detail-subtitle").textContent = (doc.filename || "Unnamed document") +
      " \u00b7 score " + formatScore(doc.score);
    renderPreview(doc);
    renderFields(doc);
    var types = Array.isArray(doc.piiTypes) ? doc.piiTypes : [];
    el("pii-line").textContent = types.length
      ? "Personal data detected: " + types.join(", ")
      : "No personal data detected.";
    el("reject-reason").value = "";
    setMessage("detail-message", "", "");
    renderQueue();
    el("detail-title").scrollIntoView({ block: "nearest" });
  }

  /* ---------- decisions ---------- */

  // Approving needs all three fields filled in. Only the changed ones are sent.
  function collectChanges() {
    var changes = {};
    var fields = current.fields || {};
    for (var i = 0; i < FIELD_DEFS.length; i++) {
      var def = FIELD_DEFS[i];
      var original = fields[def.key] && typeof fields[def.key].value === "string" ? fields[def.key].value : "";
      var value = el("field-" + def.key).value.trim();
      if (!value) {
        return { error: def.label + " is required to approve. Fill it in, or reject the document." };
      }
      if (value !== original) changes[def.key] = value;
    }
    return { changes: changes };
  }

  function submit(kind) {
    if (busy || !current) return;
    setMessage("detail-message", "", "");

    var body;
    if (kind === "approve") {
      var result = collectChanges();
      if (result.error) {
        setMessage("detail-message", result.error, "error");
        return;
      }
      body = Object.keys(result.changes).length
        ? { action: "correct", fields: result.changes }
        : { action: "approve" };
    } else {
      body = { action: "reject" };
      var reason = el("reject-reason").value.trim();
      if (reason) body.reason = reason;
    }

    var docId = current.docId;
    setBusy(true);
    setMessage("detail-message", "Saving...", "");
    window.DocuSenseApi.request("POST", "/review/" + encodeURIComponent(docId), body)
      .then(function (data) {
        var text = "Document saved.";
        if (data.status === "APPROVED") text = "Document approved.";
        else if (data.status === "CORRECTED") text = "Document corrected and approved.";
        else if (data.status === "REJECTED") text = "Document rejected.";
        hideDetail();
        return loadQueue(text);
      })
      .catch(function (err) {
        if (err.status === 404 || err.status === 409) {
          hideDetail();
          return loadQueue().then(function () {
            setMessage("queue-message", "That document is no longer waiting for review.", "error");
          });
        }
        if (err.status === 403) setMessage("detail-message", "Only reviewers can review documents.", "error");
        else setMessage("detail-message", err.message || "Could not save your decision.", "error");
      })
      .then(function () { setBusy(false); });
  }

  /* ---------- start ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.DocuSenseAuth || !window.DocuSenseAuth.isAuthenticated()) return;

    if (!window.DocuSenseAuth.isReviewer()) {
      el("not-reviewer").hidden = false;
      return;
    }
    el("review-area").hidden = false;
    el("queue-refresh-btn").addEventListener("click", function () { loadQueue(); });
    el("approve-btn").addEventListener("click", function () { submit("approve"); });
    el("reject-btn").addEventListener("click", function () { submit("reject"); });
    loadQueue();
  });
})();
