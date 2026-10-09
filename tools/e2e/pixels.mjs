// e2e 共用：用瀏覽器本身解碼 PNG，計算「卡通描邊深色像素」佔比，確認 WebGL 真的畫出東西。
// （WebGL canvas 沒有 preserveDrawingBuffer，無法直接 getImageData，所以改用截圖判斷。）

/** @param decoderPage 任一已開啟的空白 Playwright page  @param png page.screenshot() 的 Buffer */
export async function inkRatio(decoderPage, png) {
  return decoderPage.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 90 && data[i + 1] < 80 && data[i + 2] < 110) ink++;
    }
    return ink / (c.width * c.height);
  }, png.toString('base64'));
}

/**
 * 取得截圖（PNG Buffer）上指定像素的 RGBA。座標是「截圖像素」（deviceScaleFactor 為 1 時就是 CSS px）。
 * 用來檢查線圖的小球有沒有畫在對應那一列的正確位置（捲動同步）。
 * @param decoderPage 任一已開啟的空白頁  @param points [[x, y], …]
 */
export async function samplePixels(decoderPage, png, points) {
  return decoderPage.evaluate(
    async ({ b64, pts }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return pts.map(([x, y]) =>
        Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data),
      );
    },
    { b64: png.toString('base64'), pts: points },
  );
}

/** 兩個 RGB(A) 顏色的曼哈頓距離（只看 RGB）。 */
export const colorDistance = (a, b) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
