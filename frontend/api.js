/* DocuSense API client and upload flow.
   Plain JavaScript, no libraries. Needs auth.js loaded first. */
(function () {
  "use strict";

  var API_BASE = "https://6cd8dec4jj.execute-api.ap-southeast-2.amazonaws.com";
  var MAX_BYTES = 5 * 1024 * 1024; // 5 MB
  var ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg"];
  var TYPE_BY_EXT = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

  /* ---------- helpers ---------- */

  function setMessage(id, text, kind) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", kind === "error");
    el.classList.toggle("is-success", kind === "success");
  }

  function fileType(file) {
    if (file.type) return file.type;
    var dot = file.name.lastIndexOf(".");
    var ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
    return TYPE_BY_EXT[ext] || "";
  }

  /* ---------- API calls ---------- */

  function apiRequest(method, path, body) {
    if (!window.DocuSenseAuth || !window.DocuSenseAuth.requireAuth()) {
      return Promise.reject(new Error("Your session has ended. Please sign in again."));
    }
    var options = {
      method: method,
      headers: { Authorization: "Bearer " + window.DocuSenseAuth.getAccessToken() }
    };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, options).then(function (res) {
      if (res.status === 401) {
        window.DocuSenseAuth.logout();
        throw new Error("Your session has expired. Please sign in again.");
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        var message = "Something went wrong. Please try again.";
        if (res.status === 429) message = "Too many requests. Please wait a moment and try again.";
        else if (res.status === 400 && typeof data.error === "string") message = data.error;
        var error = new Error(message);
        error.status = res.status;
        throw error;
      });
    });
  }

  function requestUploadUrl(contentType, filename) {
    return apiRequest("POST", "/upload-url", { contentType: contentType, filename: filename });
  }

  // The presigned fields must come first and the file must be the last field.
  function uploadToS3(presigned, file) {
    var form = new FormData();
    Object.keys(presigned.fields).forEach(function (name) {
      form.append(name, presigned.fields[name]);
    });
    form.append("file", file);
    return fetch(presigned.url, { method: "POST", body: form }).then(function (res) {
      if (!res.ok) throw new Error("The file could not be stored. Please try again.");
    });
  }

  /* ---------- documents table ---------- */

  function formatScore(score) {
    if (typeof score !== "number") return "\u2014";
    return String(Math.round(score * 10) / 10);
  }

  function statusLabel(status) {
    var text = String(status || "").toLowerCase().replace(/_/g, " ");
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "\u2014";
  }

  function statusClass(status) {
    return "status-" + String(status || "").toLowerCase().replace(/[^a-z_]/g, "");
  }

  // Everything is written with textContent, so file names can never inject HTML.
  function renderDocuments(documents) {
    var body = document.getElementById("docs-body");
    if (!body) return;
    body.textContent = "";

    if (!documents.length) {
      var emptyRow = document.createElement("tr");
      emptyRow.className = "empty-row";
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 3;
      emptyCell.textContent = "No documents yet. Upload one above.";
      emptyRow.appendChild(emptyCell);
      body.appendChild(emptyRow);
      return;
    }

    documents.forEach(function (doc) {
      var row = document.createElement("tr");

      var nameCell = document.createElement("td");
      nameCell.textContent = doc.filename || "\u2014";

      var statusCell = document.createElement("td");
      var badge = document.createElement("span");
      badge.className = "badge " + statusClass(doc.status);
      badge.textContent = statusLabel(doc.status);
      statusCell.appendChild(badge);

      var scoreCell = document.createElement("td");
      scoreCell.className = "num";
      scoreCell.textContent = formatScore(doc.score);

      row.appendChild(nameCell);
      row.appendChild(statusCell);
      row.appendChild(scoreCell);
      body.appendChild(row);
    });
  }

  function loadDocuments() {
    var button = document.getElementById("refresh-btn");
    if (button) button.disabled = true;
    setMessage("docs-message", "Loading...", "");
    return apiRequest("GET", "/documents")
      .then(function (data) {
        renderDocuments(Array.isArray(data.documents) ? data.documents : []);
        setMessage("docs-message", "", "");
      })
      .catch(function (err) {
        setMessage("docs-message", err.message || "Could not load your documents.", "error");
      })
      .then(function () {
        if (button) button.disabled = false;
      });
  }

  /* ---------- upload form ---------- */

  function handleUpload(event) {
    event.preventDefault();
    var input = document.getElementById("file-input");
    var button = document.getElementById("upload-btn");
    setMessage("upload-message", "", "");

    var file = input.files && input.files[0];
    if (!file) {
      setMessage("upload-message", "Please choose a file first.", "error");
      return;
    }
    var type = fileType(file);
    if (ALLOWED_TYPES.indexOf(type) === -1) {
      setMessage("upload-message", "Only PDF, PNG or JPG files are allowed.", "error");
      return;
    }
    if (file.size === 0) {
      setMessage("upload-message", "That file is empty.", "error");
      return;
    }
    if (file.size > MAX_BYTES) {
      setMessage("upload-message", "That file is larger than 5 MB.", "error");
      return;
    }

    button.disabled = true;
    setMessage("upload-message", "Uploading...", "");

    requestUploadUrl(type, file.name)
      .then(function (presigned) { return uploadToS3(presigned, file); })
      .then(function () {
        input.value = "";
        setMessage("upload-message", "Uploaded. Processing has started.", "success");
        return loadDocuments();
      })
      .catch(function (err) {
        setMessage("upload-message", err.message || "Upload failed. Please try again.", "error");
      })
      .then(function () { button.disabled = false; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.getElementById("upload-form");
    if (form) form.addEventListener("submit", handleUpload);

    var refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", loadDocuments);

    if (document.getElementById("docs-body") && window.DocuSenseAuth && window.DocuSenseAuth.isAuthenticated()) {
      loadDocuments();
    }
  });

  window.DocuSenseApi = {
    request: apiRequest,
    requestUploadUrl: requestUploadUrl,
    uploadToS3: uploadToS3,
    loadDocuments: loadDocuments
  };
})();
