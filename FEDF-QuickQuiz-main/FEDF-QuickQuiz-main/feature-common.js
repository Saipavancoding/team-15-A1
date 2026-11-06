(() => {
  const token = localStorage.getItem('authToken');
  const nav = document.querySelector('.feature-nav');
  if (nav) {
    const links = [
      ['planner.html', 'Study Planner'],
      ['flashcards.html', 'Flashcards'],
      ['mock-exams.html', 'Mock Exams'],
      ['forum.html', 'Discussion Forum'],
      ['certificates.html', 'Certificates']
    ];
    links.forEach(([href, label]) => {
      if (!nav.querySelector(`a[href="${href}"]`)) {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = label;
        nav.appendChild(link);
      }
    });
  }
  window.featureAuth = {
    token,
    headers: { Authorization: `Bearer ${token}` },
    requireAuth() {
      if (!token) {
        const state = document.querySelector('[data-state]');
        if (state) {
          state.className = 'state error';
          state.innerHTML = 'Please sign in to use this feature.<br><a class="button" href="login.html">Sign in</a>';
        }
        return false;
      }
      return true;
    },
    async fetchJson(url, options = {}, timeoutMs = 10000) {
      if (!token) throw new Error('Authentication required. Please sign in.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...options,
          headers: { ...this.headers, ...(options.headers || {}) },
          signal: controller.signal
        });
        const body = await response.json().catch(() => ({}));
        if (response.status === 401) {
          localStorage.removeItem('authToken');
          throw new Error('Your session has expired. Please sign in again.');
        }
        if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
        return body;
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('The server took too long to respond. Please retry.');
        if (error instanceof TypeError) throw new Error('Unable to reach the server. Please retry.');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    showError(message, retry) {
      const state = document.querySelector('[data-state]');
      if (!state) return;
      state.className = 'state error';
      const needsLogin = message.toLowerCase().includes('sign in') || message.toLowerCase().includes('session');
      state.innerHTML = `${message}<br>${needsLogin ? '<a class="button" href="login.html">Sign in</a>' : '<button type="button" id="retryButton">Retry</button>'}`;
      if (!needsLogin) document.getElementById('retryButton').addEventListener('click', retry);
    }
  };
})();
