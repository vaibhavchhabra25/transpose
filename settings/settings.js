// settings/settings.js

async function render() {
  const list = document.getElementById('domainList');
  const { disabledDomains = [] } = await chrome.storage.sync.get(['disabledDomains']);

  if (disabledDomains.length === 0) {
    list.innerHTML = '<p class="empty-state">PitchShift is active on all sites.</p>';
    return;
  }

  list.innerHTML = disabledDomains.map(domain => `
    <div class="domain-row">
      <span class="domain-name">${escapeHtml(domain)}</span>
      <span class="domain-status">Disabled</span>
      <button class="re-enable-btn" data-domain="${escapeHtml(domain)}">Re-enable</button>
    </div>
  `).join('');

  list.querySelectorAll('.re-enable-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const domain = btn.dataset.domain;
      const { disabledDomains = [] } = await chrome.storage.sync.get(['disabledDomains']);
      await chrome.storage.sync.set({
        disabledDomains: disabledDomains.filter(d => d !== domain),
      });

      // Broadcast to all open tabs — content.js checks its own domain and
      // enables the engine if it matches. Errors on tabs without our content
      // script are expected and ignored.
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'ENABLE_IF_DOMAIN', domain })
          .catch(() => {});
      }

      render();
    });
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

render();
