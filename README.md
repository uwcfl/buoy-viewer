# Buoy Data Viewer

A web visualization tool for real-time and historical (current year) buoy data collected by the UW-Madison Center for Limnology (CFL). 

## Supported Lakes

- **Lake Mendota** (`index.html`)
- **Trout Lake** (`trout.html`)
- **Sparkling Lake** (`sparkling.html`)

## Project Structure

```
├── index.html       # Lake Mendota page
├── trout.html       # Trout Lake page
├── sparkling.html   # Sparkling Lake page
├── shared.js        # Shared D3 chart rendering, data binning, and interaction logic
├── mendota.js       # Lake Mendota configuration and parser
├── trout.js         # Trout Lake configuration and dual-endpoint parser
├── sparkling.js     # Sparkling Lake configuration and dual-endpoint parser
├── style.css        # Stylesheet and responsive layout definitions
└── assets/          # Logotype and buoy images
```

