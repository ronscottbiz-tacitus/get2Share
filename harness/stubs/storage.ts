export const getStorage = () => ({});
export const ref = () => ({});
// Local deck capture: hand back the photo that was actually taken.
let last: string | null = null;
export const uploadBytes = async (_r: any, blob: any) => { try { last = URL.createObjectURL(blob); } catch { last = null; } return { ref: {} }; };
export const getDownloadURL = async () => last || "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23503a8a'/><stop offset='1' stop-color='%23e07a5f'/></linearGradient></defs><rect width='1200' height='800' fill='url(%23g)'/></svg>";
export const deleteObject = async () => {};
