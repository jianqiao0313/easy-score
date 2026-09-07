# Audiveris in the container image

The image contains the official Audiveris 5.11.0 Ubuntu 24.04 x86_64 package.
Audiveris is licensed under the GNU Affero General Public License version 3.
The installed package's copyright and license files are under
`/usr/share/doc/audiveris/`.

An archive of the Audiveris project's source at the release commit is included at:

`/usr/share/source/audiveris/audiveris-5.11.0.tar.gz`

It is pinned to Git commit `9e1e55cd2746037d059345881c53e6a6754bffbd` and is
also available from:

https://github.com/Audiveris/audiveris/tree/9e1e55cd2746037d059345881c53e6a6754bffbd

The official binary release is published at:

https://github.com/Audiveris/audiveris/releases/tag/5.11.0

This archive is not an audited complete Corresponding Source bundle for every
component in the upstream installer. In particular, bundled Java libraries,
native libraries and the Java runtime have separate licenses and may require
additional corresponding source and build information when redistributed.
Retain the installed notices and review those components before claiming that
the image fulfills all source-distribution obligations. Running Audiveris as a
subprocess does not by itself decide whether an integration is a separate work.

See the repository's THIRD_PARTY_NOTICES.md for the audit scope, requirements
and outstanding source-completeness checks. The easy-score MIT license does
not relicense Audiveris or any other third-party component.

Audiveris currently publishes Linux installers only for x86_64, so this image
targets `linux/amd64`.
