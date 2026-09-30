// The cover (manual/index.html): the window at a glance, the Work View as a first launch opens it
module.exports = [
  { name: 'welcome-window', panes: 2, size: '1440x900', setup: [
    { js: 'tana.myTasks().then((n) => goTo(n.id))', page: '2' }, { wait: 1200 },
  ] },
];
