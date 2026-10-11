(() => {
  const lab = parent.LocKeepLab || parent.getActiveLab?.();
  if (!lab) { document.body.textContent = 'Paneli simülasyon sayfasından açın.'; throw new Error('No simulation session'); }
  window.chrome = { runtime: lab.runtime,
    tabs: { query: async () => [{ id: 1, url: lab.pageURL() }],
      sendMessage: async () => lab.requestDiagnostics() } };
})();
