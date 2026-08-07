const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.commandLine.appendSwitch('disable-gpu')

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => {
    const rectangle = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    document.body.innerHTML = '<main class="app"><header class="topbar"></header><div class="tab-page player-page"><section class="viewer-shell"><div class="media-stage"><div class="video"></div><div class="exact-frame"></div></div></section><section class="control-panel" style="height:180px"></section></div></main>'
    const player = {
      stage: rectangle('.media-stage'),
      video: rectangle('.video'),
      exact: rectangle('.exact-frame'),
      exactBackground: getComputedStyle(document.querySelector('.exact-frame')).backgroundColor,
    }
    document.body.innerHTML = '<main class="app"><header class="topbar"></header><section class="concat-page"><div class="concat-heading"><h1>動画を連結</h1></div><button class="concat-drop-zone">動画をドロップ</button><div class="concat-list"><article class="concat-item"></article></div><footer class="concat-footer"><div>2本</div><button>連結</button></footer></section></main>'
    return {
      player,
      concat: {
        page: rectangle('.concat-page'),
        list: rectangle('.concat-list'),
        footer: rectangle('.concat-footer'),
      },
      viewport: { width: innerWidth, height: innerHeight },
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
    if (!sameRectangle(result.player.stage, result.player.video) || !sameRectangle(result.player.stage, result.player.exact)) {
      throw new Error(`Overlay geometry mismatch at ${width}x${height}: ${JSON.stringify(result)}`)
    }
    if (result.player.exactBackground === 'rgba(0, 0, 0, 0)') {
      throw new Error(`Overlay is transparent at ${width}x${height}`)
    }
    if (result.concat.list.height <= 0 || result.concat.footer.y + result.concat.footer.height > result.concat.page.y + result.concat.page.height + 0.01) {
      throw new Error(`Concat layout overflow at ${width}x${height}: ${JSON.stringify(result.concat)}`)
    }
  }

  window.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
