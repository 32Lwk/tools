# X-ray Laue backscattering simulator (fork: cylindrical IP)

Fork of [taro-nakajima/xray-laue-backscattering-simulator](https://github.com/taro-nakajima/xray-laue-backscattering-simulator) with **cylindrical (unrolled IP) detector geometry**.

- **Web (this fork):** https://32lwk.github.io/xray-laue-backscattering-simulator/
- **Repository:** https://github.com/32Lwk/xray-laue-backscattering-simulator
- **Version:** `1.3-cyl`
- **Upstream:** https://taro-nakajima.github.io/xray-laue-backscattering-simulator/
- **Tutorial (JP, upstream):** https://sites.google.com/view/t-nakajima-group/tools/xray_laue_simulator

## Changes in this fork

The upstream simulator supports a **flat detector** only. Some Laue setups use a **cylindrical imaging plate** read out as an unrolled BMP. This fork adds:

- **Det. geometry:** `Flat` / `Cylindrical (unrolled IP, R=Lsd)` in `index.html` and `index_offline.html`
- Cylindrical projection in `xray_laue_detector_map.js` (`drawBraggReflection`)

### Cylindrical mode

- Horizontal: \(u = R\,\delta\), \(\delta = \mathrm{atan2}(k_{fy}, -k_{fx})\)
- Vertical: \(v = R\,k_{fz}/\sqrt{k_{fx}^2 + k_{fy}^2}\)
- Radius \(R = L_{sd}\); includes backscattering and part of forward scattering reaching the cylinder

Usage: set **Det. geometry → Cylindrical**, load a BMP, then fit orientation.

## License

MIT License. See [LICENSE](LICENSE).  
Based on software Copyright (c) 2020 Taro Nakajima.

## Offline use

Download this repository, then get [three.js](https://threejs.org/) (`three.js-master.zip`) and extract it in the same folder.

Open `index_offline.html` (uses `./three.js-master/build/three.min.js`).

For the online version (`index.html`), three.js is loaded from CDN; a local HTTP server is required (`file://` does not work for modules).
