# Vendored Dependency: PSVirtualDesktop

- **Source:** https://github.com/MScholtes/PSVirtualDesktop
- **Branch:** master (downloaded 2026-05-18)
- **License:** MIT (see LICENSE file)
- **Files:** VirtualDesktop.psm1, VirtualDesktop.psd1, VirtualDesktop.ps1, functions.cat
- **SHA-256 (VirtualDesktop.psm1):** AC6FEC3B920D3D2466CF1BB2DC28952E0D165974FAB9AAF56C81C0C0DECF34E7
- **SHA-256 (VirtualDesktop.ps1):** 108BA45CCBE1B077A79C36953535DBDD2920E1AA03A51F935BBD06B6FB61747C

## Why vendored

IMs should not need to run `Install-Module` or trust PSGallery.
The module is imported by absolute path in every PowerShell invocation.
