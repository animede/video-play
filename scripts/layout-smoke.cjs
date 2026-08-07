const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.commandLine.appendSwitch('disable-gpu')

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => {
    document.body.innerHTML = '<main class="app"><header class="topbar"></header><section class="viewer-shell"><div class="media-stage"><div class="video"></div><div class="exact-frame"></div></div></section><section class="control-panel" style="height:180px"></section></main>'
    const rectangle = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    return {
      stage: rectangle('.media-stage'),
      video: rectangle('.video'),
      exact: rectangle('.exact-frame'),
      exactBackground: getComputedStyle(document.querySelector('.exact-frame')).backgroundColor,
    }
  })()`)
}

function sameRectangle(left, right) {
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(left[key] - right[key]) < 0.01)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 760 })
  await window.loadFile(path.join(__dirname, '../dist/index.html'))

  for (const [width, height] of [[1200, 760], [760, 560]]) {
    window.setSize(width, height)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const result = await measure(window)
    if (!sameRectangle(result.stage, result.video) || !sameRectangle(result.stage, result.exact)) {
      throw new Error(`Overlay geometry mismatch at ${width}x${height}: ${JSON.stringify(result)}`)
    }
    if (result.exactBackground === 'rgba(0, 0, 0, 0)') {
      throw new Error(`Overlay is transparent at ${width}x${height}`)
    }
  }

  window.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
