import qrcode from "./vendor/qrcode-generator.js";

qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];

/** SVG-Markup für einen QR-Code. Kein Netzaufruf. */
export function makeQrSvg(text, alt = "QR-Code") {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  return qr.createSvgTag({
    scalable: true,
    margin: 2,
    alt,
  });
}
