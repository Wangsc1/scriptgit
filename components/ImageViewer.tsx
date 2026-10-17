import {
  ProgressView,
  VStack,
  WebView,
  ZStack,
  useEffect,
  useMemo,
  useState,
} from "scripting"

// 图片查看器页面：缩放、双击放大与惯性平移交给 WebKit 原生处理
function buildHTML(url: string, compactImage: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=6, user-scalable=yes${compactImage ? ", viewport-fit=cover" : ""}">
<style>
${compactImage ? "  :root { color-scheme: light dark; }\n  @media (prefers-color-scheme: dark) { html, body { background: #242424 !important; } .failed { color: #fff; } }\n  @media (prefers-color-scheme: light) { .failed { color: #111; } }" : ""}
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    background: ${compactImage ? "#fff" : "#000"};
    -webkit-user-select: none;
    user-select: none;
  }
  .stage {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    ${compactImage ? "box-sizing: border-box; padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);" : ""}
  }
  img {
    max-width: ${compactImage ? "80%" : "100%"};
    max-height: ${compactImage ? "60%" : "100%"};
    ${compactImage ? "width: auto; height: auto; object-fit: contain;" : ""}
    -webkit-touch-callout: none;
    /* 加载完成前不显示，避免出现半张图 */
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  ${compactImage ? `/* Local-only alpha visualization; attached to image bounds, not stage. */
  img {
    background-color: #fff;
    background-image: conic-gradient(#bbb 25%, #fff 0 50%, #bbb 0 75%, #fff 0);
    background-size: 16px 16px;
  }
  @media (prefers-color-scheme: dark) {
    img { background-color: #666; background-image: conic-gradient(#444 25%, #777 0 50%, #444 0 75%, #777 0); }
  }` : ""}
  img.ready {
    opacity: 1;
  }
  .spinner {
    position: fixed;
    top: 50%;
    left: 50%;
    width: 32px;
    height: 32px;
    margin: -16px 0 0 -16px;
    border: 3px solid rgba(255, 255, 255, 0.25);
    border-top-color: rgba(255, 255, 255, 0.9);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .spinner.hidden {
    display: none;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .failed {
    color: ${compactImage ? "#111" : "#fff"};
    font: 15px -apple-system;
  }
</style>
</head>
<body>
<div class="stage" id="stage">
  <img id="photo" src="${url}" alt="">
</div>
<div class="spinner" id="spinner"></div>
<script>
  var photo = document.getElementById("photo")
  var stage = document.getElementById("stage")
  var spinner = document.getElementById("spinner")

  function hideSpinner() {
    spinner.classList.add("hidden")
  }

  function showPhoto() {
    hideSpinner()
    photo.classList.add("ready")
  }

  // 缓存命中时 load 可能已错过，靠 complete 补一次
  if (photo.complete && photo.naturalWidth > 0) {
    showPhoto()
  } else {
    photo.addEventListener("load", showPhoto)
  }

  photo.addEventListener("error", function () {
    hideSpinner()
    stage.innerHTML = '<div class="failed">图片加载失败</div>'
  })

  // 仅在未缩放且未发生位移时把单击视为关闭
  var startX = 0
  var startY = 0
  var multiTouch = false
  var pullClosed = false
  document.addEventListener("touchstart", function (event) {
    var touch = event.touches[0]
    multiTouch = event.touches.length > 1
    pullClosed = false
    startX = touch.clientX
    startY = touch.clientY
  }, { passive: true })
  ${compactImage ? `// 本地图片：未缩放时支持左边缘右滑返回，保留原有下拉关闭；多指/放大平移不关闭。
  document.addEventListener("touchmove", function (event) {
    if (event.touches.length > 1) { multiTouch = true; return }
    if (multiTouch || pullClosed) return
    var touch = event.touches[0]
    var dx = touch.clientX - startX
    var dy = touch.clientY - startY
    var scale = window.visualViewport ? window.visualViewport.scale : 1
    var edgeBack = startX <= 24 && dx >= 80 && dx > Math.abs(dy) * 1.5
    var pullDown = dy > 120 && Math.abs(dx) < dy * 0.5
    if (scale <= 1.01 && (edgeBack || pullDown)) {
      pullClosed = true
      window.webkit.messageHandlers.closeViewer.postMessage(null)
    }
  }, { passive: true })
  document.addEventListener("touchcancel", function () { multiTouch = true }, { passive: true })` : ""}

  document.addEventListener("touchend", function (event) {
    if (event.touches.length > 0) {
      return
    }
    var touch = event.changedTouches[0]
    ${compactImage ? `// Fast swipes may cross the threshold only in the final touchend sample.
    var dx = touch.clientX - startX
    var dy = touch.clientY - startY
    var scale = window.visualViewport ? window.visualViewport.scale : 1
    if (!pullClosed && !multiTouch && scale <= 1.01 &&
      ((startX <= 24 && dx >= 80 && dx > Math.abs(dy) * 1.5) || (dy > 120 && Math.abs(dx) < dy * 0.5))) {
      pullClosed = true
      window.webkit.messageHandlers.closeViewer.postMessage(null)
      return
    }` : ""}
    var moved = Math.abs(touch.clientX - startX) > 8 || Math.abs(touch.clientY - startY) > 8
    var zoomed = window.visualViewport && window.visualViewport.scale > 1.01
    if (pullClosed || multiTouch || moved || zoomed) {
      return
    }
    window.webkit.messageHandlers.closeViewer.postMessage(null)
  }, { passive: true })
</script>
</body>
</html>`
}

export function ImageViewer({
  url,
  onClose,
  compactImage = false,
  sessionId,
}: {
  url: string
  onClose: () => void
  /** 本地图片默认缩小，仍使用全屏及原有缩放/关闭；共享调用默认不变。 */
  compactImage?: boolean
  sessionId?: number
}) {
  // 控制器随图片地址重建，避免复用已 dispose 的实例
  const controller = useMemo(() => new WebViewController(), [url, compactImage, sessionId])
  const [webViewReady, setWebViewReady] = useState(false)

  useEffect(() => {
    let disposed = false
    setWebViewReady(false)

    async function setup() {
      let closing = false
      await controller.addScriptMessageHandler("closeViewer", () => {
        if (disposed || closing) return
        closing = true
        onClose()
      })
      if (!disposed) {
        await controller.loadHTML(buildHTML(url, compactImage))
      }
      // WebView 自身初始化期间是黑屏，就绪后再撤掉原生指示器
      if (!disposed) {
        setWebViewReady(true)
      }
    }

    setup()

    return () => {
      disposed = true
      controller.dispose()
    }
    // url 变化时必须重新加载，否则多张图片只会显示首次打开的那张
  }, [url, compactImage, sessionId])

  return (
    <ZStack
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background={compactImage ? { light: "white", dark: "#242424" } : "black"}
      ignoresSafeArea={{ regions: "all", edges: "all" }}
    >
      {webViewReady ? null : <ProgressView progressViewStyle="circular" tint={compactImage ? { light: "#555555", dark: "white" } : "white"} />}
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <WebView controller={controller} />
      </VStack>
    </ZStack>
  )
}
