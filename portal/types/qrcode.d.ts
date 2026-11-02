// Minimal ambient types for `qrcode` (the package ships no.d.ts and we don't want a network
// install for @types/qrcode). We only use toDataURL client-side to render the invite QR.
declare module "qrcode" {
  export interface QRCodeToDataURLOptions {
    margin?: number;
    width?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    color?: { dark?: string; light?: string };
  }
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  const _default: { toDataURL: typeof toDataURL };
  export default _default;
}
