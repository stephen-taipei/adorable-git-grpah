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
