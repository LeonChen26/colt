(function () {
  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  mermaid.initialize({
    startOnLoad: true,
    theme: 'base',
    securityLevel: 'loose',
    fontFamily: css('--font'),
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
    er: { useMaxWidth: false },
    themeVariables: {
      primaryColor: css('--bg2'),
      primaryTextColor: css('--ink'),
      primaryBorderColor: css('--rule'),
      secondaryColor: css('--bg'),
      tertiaryColor: css('--bg2'),
      lineColor: css('--muted'),
      textColor: css('--ink'),
      mainBkg: css('--bg2'),
      nodeBorder: css('--rule'),
      clusterBkg: css('--bg'),
      clusterBorder: css('--rule'),
      titleColor: css('--ink'),
      edgeLabelBackground: css('--bg'),
      actorBkg: css('--bg2'),
      actorBorder: css('--rule'),
      actorTextColor: css('--ink'),
      actorLineColor: css('--muted'),
      signalColor: css('--muted'),
      signalTextColor: css('--ink'),
      labelBoxBkgColor: css('--bg2'),
      labelBoxBorderColor: css('--rule'),
      labelTextColor: css('--ink'),
      loopTextColor: css('--ink'),
      noteBkgColor: css('--bg2'),
      noteBorderColor: css('--rule'),
      noteTextColor: css('--ink'),
      attributeBackgroundColorOdd: css('--bg2'),
      attributeBackgroundColorEven: css('--bg')
    }
  });
})();
