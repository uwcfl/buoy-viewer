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


## No-Data Modals

On load, each page finds the most recent reading and may show a modal over the viewer:

- **Buoy offline** — no data for `offlineHours` (default 12). Button: "Explore Earlier Data".
- **Out for the winter** — no data in any variable for 24 hours between Nov 1 and the season start, or
  forced with `forceWinterModal: true` in the lake's config (`mendota.js`, `trout.js`,
  `sparkling.js`). Button: "Explore Data from <year of last reading>".

From Jan 1 until the season start (`earliest`), the viewer shows the previous year's season.

Current Conditions always shows the last 12 hours (regardless of the selected range) and is
hidden by default whenever the offline/winter modal applies. While the buoy is reporting, a
sensor's card is hidden after 6 hours without data, and its chart after 24 hours (the
Show/Hide buttons still override this).
Water temp profile ranges come from `waterTempRange` and widen to fit any readings outside it.
