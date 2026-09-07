# Audiveris in the container image

The image contains the official Audiveris 5.11.0 Ubuntu 24.04 x86_64 package.
Audiveris is licensed under the GNU Affero General Public License version 3.
The installed package's copyright and license files are under
`/usr/share/doc/audiveris/`.

The complete corresponding source for the bundled release is included at:

`/usr/share/source/audiveris/audiveris-5.11.0.tar.gz`

It is pinned to Git commit `9e1e55cd2746037d059345881c53e6a6754bffbd` and is
also available from:

https://github.com/Audiveris/audiveris/tree/9e1e55cd2746037d059345881c53e6a6754bffbd

The official binary release is published at:

https://github.com/Audiveris/audiveris/releases/tag/5.11.0

Audiveris currently publishes Linux installers only for x86_64, so this image
targets `linux/amd64`.
