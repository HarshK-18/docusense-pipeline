/* DocuSense auth: Cognito hosted login with authorization code + PKCE.
   Plain JavaScript, no libraries. Tokens are kept in sessionStorage only. */
(function () {
  "use strict";

  var CONFIG = {
    cognitoDomain: "https://ap-southeast-236akmdl0g.auth.ap-southeast-2.amazoncognito.com",
    clientId: "153ephea1t0ei009h531ei2ko4",
    scope: "openid email"
  };

  // Works on localhost and, later, on the CloudFront address.
  var REDIRECT_URI = window.location.origin + "/";
  var LOGOUT_URI = window.location.origin + "/";

  var KEY = {
    verifier: "docusense.pkce_verifier",
    state: "docusense.oauth_state",
    access: "docusense.access_token",
    id: "docusense.id_token",
    expires: "docusense.expires_at"
  };

  /* ---------- helpers ---------- */

  function base64Url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(byteLength) {
    var bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  function pkceChallenge(verifier) {
    var data = new TextEncoder().encode(verifier);
    return crypto.subtle.digest("SHA-256", data).then(function (hash) {
      return base64Url(new Uint8Array(hash));
    });
  }

  function decodeJwtPayload(token) {
    try {
      var part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (part.length % 4) part += "=";
      var bin = atob(part);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      return null;
    }
  }

  function setMessage(id, text, isError) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", !!isError);
  }

  /* ---------- session ---------- */

  function clearSession() {
    Object.keys(KEY).forEach(function (k) { sessionStorage.removeItem(KEY[k]); });
  }

  function isAuthenticated() {
    var token = sessionStorage.getItem(KEY.access);
    var expires = Number(sessionStorage.getItem(KEY.expires));
    return !!token && expires - 30000 > Date.now();
  }

  function getAccessToken() {
    return isAuthenticated() ? sessionStorage.getItem(KEY.access) : null;
  }

  // Groups come from the access token. This only decides what to SHOW;
  // the API is what actually enforces who may review.
  function getGroups() {
    var token = sessionStorage.getItem(KEY.access);
    var claims = token ? decodeJwtPayload(token) : null;
    var groups = claims && claims["cognito:groups"];
    return Array.isArray(groups) ? groups : [];
  }

  function isReviewer() {
    return isAuthenticated() && getGroups().indexOf("reviewers") !== -1;
  }

  function getEmail() {
    var idToken = sessionStorage.getItem(KEY.id);
    var claims = idToken ? decodeJwtPayload(idToken) : null;
    return claims && claims.email ? claims.email : "";
  }

  /* ---------- login / logout ---------- */

  function login() {
    var verifier = randomString(32);
    var state = randomString(16);
    pkceChallenge(verifier).then(function (challenge) {
      sessionStorage.setItem(KEY.verifier, verifier);
      sessionStorage.setItem(KEY.state, state);
      var params = new URLSearchParams({
        response_type: "code",
        client_id: CONFIG.clientId,
        redirect_uri: REDIRECT_URI,
        scope: CONFIG.scope,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: state
      });
      window.location.assign(CONFIG.cognitoDomain + "/oauth2/authorize?" + params.toString());
    });
  }

  function logout() {
    clearSession();
    var params = new URLSearchParams({
      client_id: CONFIG.clientId,
      logout_uri: LOGOUT_URI
    });
    window.location.assign(CONFIG.cognitoDomain + "/logout?" + params.toString());
  }

  // Runs on the landing page after Cognito sends the browser back with ?code=...
  function handleCallback() {
    var query = new URLSearchParams(window.location.search);
    var code = query.get("code");
    var error = query.get("error");
    if (!code && !error) return Promise.resolve(false);

    var returnedState = query.get("state");
    var savedState = sessionStorage.getItem(KEY.state);
    var verifier = sessionStorage.getItem(KEY.verifier);
    sessionStorage.removeItem(KEY.state);
    sessionStorage.removeItem(KEY.verifier);
    window.history.replaceState({}, document.title, window.location.pathname);

    if (error) {
      setMessage("login-message", "Sign-in was not completed. Please try again.", true);
      return Promise.resolve(true);
    }
    if (!savedState || !returnedState || savedState !== returnedState || !verifier) {
      setMessage("login-message", "Sign-in could not be verified. Please try again.", true);
      return Promise.resolve(true);
    }

    setMessage("login-message", "Signing you in...", false);
    return fetch(CONFIG.cognitoDomain + "/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CONFIG.clientId,
        code: code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      }).toString()
    })
      .then(function (res) {
        if (!res.ok) throw new Error("token request failed");
        return res.json();
      })
      .then(function (tokens) {
        sessionStorage.setItem(KEY.access, tokens.access_token);
        sessionStorage.setItem(KEY.id, tokens.id_token);
        sessionStorage.setItem(KEY.expires, String(Date.now() + tokens.expires_in * 1000));
        window.location.replace("app.html");
        return true;
      })
      .catch(function () {
        setMessage("login-message", "Sign-in failed. Please try again.", true);
        return true;
      });
  }

  // Protects app.html: no valid token means back to the landing page.
  function requireAuth() {
    if (!isAuthenticated()) {
      clearSession();
      window.location.replace("index.html");
      return false;
    }
    return true;
  }

  /* ---------- page wiring ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    var loginBtn = document.getElementById("login-btn");
    var logoutBtn = document.getElementById("logout-btn");

    if (loginBtn) {
      loginBtn.addEventListener("click", login);
      handleCallback().then(function (handled) {
        if (!handled && isAuthenticated()) window.location.replace("app.html");
      });
    }

    if (logoutBtn) {
      if (!requireAuth()) return;
      logoutBtn.addEventListener("click", logout);
      var emailEl = document.getElementById("user-email");
      if (emailEl) emailEl.textContent = getEmail();
      var reviewLink = document.getElementById("review-link");
      if (reviewLink && isReviewer()) reviewLink.hidden = false;
    }
  });

  window.DocuSenseAuth = {
    login: login,
    logout: logout,
    isAuthenticated: isAuthenticated,
    getAccessToken: getAccessToken,
    getEmail: getEmail,
    isReviewer: isReviewer,
    requireAuth: requireAuth,
    pkceChallenge: pkceChallenge
  };
})();
