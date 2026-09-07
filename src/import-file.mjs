const FORMATS = [
  { extensions: ['pdf'], mime: 'application/pdf', sourceType: 'pdf' },
  { extensions: ['musicxml', 'xml'], mime: 'application/vnd.recordare.musicxml+xml', sourceType: 'musicxml', aliases: ['application/xml', 'text/xml'] },
  { extensions: ['mxl'], mime: 'application/vnd.recordare.musicxml', sourceType: 'musicxml', aliases: ['application/zip', 'application/x-zip-compressed'] },
  { extensions: ['png'], mime: 'image/png', sourceType: 'image' },
  { extensions: ['jpg', 'jpeg'], mime: 'image/jpeg', sourceType: 'image' },
];

export function importFormat(file) {
  const extension = file.name?.split('.').pop()?.toLowerCase();
  const mime = file.type?.split(';')[0].trim().toLowerCase();
  const byExtension = FORMATS.find((format) => format.extensions.includes(extension));
  const byMime = FORMATS.find((format) => format.mime === mime || format.aliases?.includes(mime));
  if (byExtension && (!mime || mime === 'application/octet-stream' || byMime === byExtension)) return byExtension;
  // Files without an extension may still carry a precise browser-provided MIME.
  if (!file.name?.includes('.') && mime !== 'application/zip' && mime !== 'application/x-zip-compressed') return byMime || null;
  return null;
}
