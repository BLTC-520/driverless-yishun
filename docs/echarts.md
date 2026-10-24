# Charts with Apache ECharts

The site draws its charts with two libraries:

| Charts | Library | File |
|---|---|---|
| Part 2 on the study page: value per SGD 1, cost against time saved, savings by period, cost by class, passenger time, cost swings | [Apache ECharts](https://echarts.apache.org) 6.0.0 | `web/src/phase2.js` |
| The evidence page: calibration, GPS check, sensitivity, cost swings | Apache ECharts 6.0.0 | `web/src/evidence.js` |
| Part 1 on the study page: the scroll-story charts, the waffle, the unit chart, the map | D3 7.9.0 (and deck.gl for the map) | `web/src/app.js` |

The Part 1 charts redraw step by step as the captions scroll past, and several are bespoke (one mark per ride, one per vehicle).
D3 is the better tool for that, so they stay in D3. Everything else is a standard line, bar, scatter or range chart, which is what
ECharts is built for. The shared set-up for both ECharts pages is `web/src/charts.js`.

This page explains how that set-up works, then how to change or add a chart.

## 1. How a page loads ECharts

ECharts is one JavaScript file. Each page loads it from a CDN before its own scripts:

```html
<script src="https://cdn.jsdelivr.net/npm/echarts@6.0.0/dist/echarts.min.js"></script>  <!-- defines window.echarts -->
<script src="charts.js"></script>    <!-- the shared theme and helpers: defines window.Charts -->
<script src="phase2.js"></script>    <!-- or evidence.js: draws the charts -->
```

The version is pinned (`@6.0.0`), so the site never changes under you when ECharts releases a new version. To upgrade, change the
number in `web/src/index.html` and `web/src/evidence.html`, rebuild and check every chart. `web/build.py` copies `charts.js` into
`web/dist` with the other scripts.

There is no npm install and no bundler: the site stays a set of static files. If you later want a smaller download, ECharts can
build a custom file with only the chart types the site uses (see "Custom build" in the
[ECharts handbook](https://echarts.apache.org/handbook/en/basics/download)).

## 2. The three steps of every ECharts chart

1. **A container with a size.** ECharts draws into a `<div>`, and the div must have a width and a height, or nothing appears.
   In the HTML, each chart is a div with a starting height:

   ```html
   <div id="ch-p2-time" class="ec" style="height:300px" role="img" aria-label="Passenger-hours per weekday by option"></div>
   ```

2. **`echarts.init(div)`** creates a chart in that div, once.
3. **`chart.setOption(option)`** draws it. The option is one plain object that describes the whole chart: axes, data, colours,
   tooltip. To change the chart, you call `setOption` again with a new option. When the page width changes, `chart.resize()` fits
   the chart to its div.

A complete chart, outside this project, is this short:

```js
const chart = echarts.init(document.getElementById("demo"));
chart.setOption({
  xAxis: { type: "category", data: ["Early", "Morning peak", "Off-peak", "Evening peak", "Late evening"] },
  yAxis: { type: "value" },
  tooltip: { trigger: "axis" },
  series: [{ type: "line", name: "B 450", data: [1262, 1199, 6029, 2937, 2516] }],
});
addEventListener("resize", () => chart.resize());
```

The rest of this page is about the option object, and about the helpers in `charts.js` that keep the site's charts consistent.

## 3. The option object, piece by piece

These are the parts the site uses. The [option reference](https://echarts.apache.org/en/option.html) lists every setting.

| Key | What it does | Example in this project |
|---|---|---|
| `grid` | The plot area's margins inside the div, in pixels | `{ left: 100, right: 58, top: 8, bottom: 40 }` leaves room for row names on the left |
| `xAxis`, `yAxis` | `type: "value"` for numbers, `"category"` for named rows or columns. `min`, `max`, `interval` fix the scale; `inverse: true` puts the first row at the top | `yAxis: { type: "category", inverse: true, data: ids }` |
| `axisLabel.formatter` | Turns a tick value into text | ``(v) => (v ? `${v / 1000}k` : "0")`` |
| `series` | The marks. Each entry has a `type` and `data` | `{ type: "bar", stack: "time", data: [...] }` |
| `tooltip` | What appears on hover. `trigger: "item"` for the mark under the pointer, `"axis"` for everything in the row or column under it | `{ trigger: "axis", formatter: (ps) => "<b>...</b>" }` |
| `markLine`, `markArea` | Reference lines and shaded bands, set on a series | the dashed "worth what it costs" line at 1.00 |
| `label`, `endLabel` | Text on the marks themselves | the totals at the end of each bar; the design names at the end of each line |

Series types used here: `line`, `bar` (with `stack` for stacked bars), `scatter`, and `custom` (section 5).

**Data and colours per item.** A series' `data` can be plain numbers, or objects when one item needs its own style:

```js
data: ids.map((i) => ({ value: hours[i], itemStyle: { color: familyColor(cfg[i]) } }))
```

ECharts keeps any extra fields you put on these objects, and hands them back to the tooltip formatter as `params.data`. The trade-off
chart uses this to carry each design's full record (`{ value: [x, y], p }`) to its tooltip.

## 4. What `charts.js` adds

`charts.js` runs once per page and defines `window.Charts`.

**A theme from the page's CSS.** It reads the colour tokens (`--fg`, `--mute`, `--rule`, `--bg-2`, `--font-data`...) with
`getComputedStyle` and registers them as an ECharts theme named `"yishun"`. That's why axis lines, gridlines and tick labels match the
rest of the page without any chart setting them. To restyle every chart, change the tokens in the page's `:root` CSS.

**`Charts.draw(id, option, height)`** is the one function the page scripts call. It:

- returns `null` without drawing when the div has no width yet. The Part 2 detail charts sit in a closed `<details>`, and
  `phase2.js` draws them again when it opens.
- sets the div's height (charts whose height depends on the number of rows pass it in),
- creates the chart the first time (`echarts.init(div, "yishun", { renderer: "svg" })`), and reuses it afterwards,
- adds the shared tooltip style and turns animation off for readers who ask for reduced motion,
- calls `setOption(option, true)`. The `true` replaces the previous chart outright, so nothing from the last staffing case is left behind.

`renderer: "svg"` draws the chart as SVG instead of the default canvas. The marks stay crisp at any zoom, and the browser's text tools see the labels.

**Text helpers.**

- `lab()` and `callout()` give a label the old D3 `.lab` (grey) and `.callout` (ink) look, with a halo in the paper colour so
  text stays readable over gridlines.
- `xName()` and `yName()` place axis titles where the site has always put them: x under the right end of the axis, y above it.
- `rowNames()` puts row names beside each row, cut to fit the margin with "…". `rowNamesAbove()` is the phone version, with names
  above each row.

**`Charts.nice(v)`** rounds an axis end up to a readable number. It's only needed when the code must know the axis end before ECharts
draws, as for the rays on the trade-off chart.

## 5. The escape hatch: custom series

ECharts has no ready-made "range bar" or "error bar", which several charts here need: the low-to-high value-of-time line, the GPS
95 % intervals, the cost swings. For those, a `custom` series lets you draw each data item yourself. ECharts calls your
`renderItem(params, api)` once per item:

- `api.value(0)` reads the item's first value, `api.value(1)` the second, and so on,
- `api.coord([x, y])` turns data values into pixel positions,
- `api.visual("color")` is the item's colour,
- you return a shape (`line`, `rect`, `group`...) in pixels.

`charts.js` wraps the two shapes the site needs:

```js
Charts.segments([{ value: [x0, y0, x1, y1], itemStyle: { color } }, ...])   // a line from (x0, y0) to (x1, y1)
Charts.spans([{ value: [x0, row, x1], itemStyle: { color } }, ...], { height: 12 })   // a bar from x0 to x1 on one row
```

On a category axis, rows count from 0, so `[lo, 2, hi, 2]` is a line across the third row. The low-to-high bracket under the cost
bars (`drawCost` in `phase2.js`) is a custom series written in full, if you want to see one without a helper.

## 6. One chart, line by line: passenger time

`drawTime()` in `web/src/phase2.js` draws two stacked bars per design: waiting hours (lighter) and in-vehicle hours.

```js
const bar = (j, extra) => ({ type: "bar", stack: "time", barWidth: 22,
  data: ids.map((i) => ({ value: val(cfg[i])[j], itemStyle: { color: familyColor(cfg[i]) } })), ...extra });
```

Two bar series with the same `stack` name are drawn end to end. `j` picks waiting (0) or in-vehicle (1) hours; each bar takes its
design's colour (A teal, B amber, C purple).

```js
Charts.draw("ch-p2-time", {
  grid: { left: 100, right: 58, top: 8, bottom: 40 },
```

100 px on the left for the design names, 58 on the right for the totals.

```js
  xAxis: { type: "value", min: 0, max: xMax, splitNumber: W < 480 ? 3 : 5, axisLabel: { formatter: kfmt }, ...xName("passenger-hours per weekday", 24) },
  yAxis: { type: "category", inverse: true, data: ids, axisTick: { show: false },
    axisLabel: Charts.rowNames((i) => (cfg[i].option === "A" ? "A: today" : cfg[i].short), 92) },
```

Hours run along x, with fewer ticks on phones. The rows are the design ids, first at the top (`inverse`), shown by their short names.

```js
  tooltip: { trigger: "axis", axisPointer: band, formatter: (ps) => { const c = cfg[ps[0].axisValue]; /* ... */ } },
```

Hovering anywhere in a row shades it and shows that design's numbers. `ps[0].axisValue` is the row's id.

```js
  series: [
    bar(0, { name: "waiting", itemStyle: { opacity: 0.45, borderColor: COL.surface, borderWidth: 1 } }),
    bar(1, { name: "in-vehicle", itemStyle: { borderRadius: [0, 4, 4, 0] },
      label: lab({ show: true, position: "right", distance: 6, formatter: (p) => fmt(/* total */) }) }),
  ],
}, 300);
```

Waiting is the lighter part, with a thin paper-coloured border as a gap. In-vehicle has rounded right corners and carries the total as
a label at its end. The chart is 300 px tall.

## 7. Recipes

**Change a colour.** Series colours come from the CSS tokens at the top of the page, such as `--p2-a`, `--p2-b`, `--p2-c` and
`--bus`. Change the token, and the chart, its legend and the text that refers to it all follow.

**Change a tooltip.** Find the chart's `tooltip.formatter` and edit the HTML it returns. `<b>` is bold, and
`<span class="mute">` is grey (styled by `.ec-tip .mute` in the page CSS).

**Add a reference line.** Add a `markLine` to any series:

```js
markLine: { silent: true, symbol: "none", lineStyle: { color: COL.ink, type: [4, 4] },
  label: lab({ formatter: "target", position: "start" }), data: [{ xAxis: 30 }] }
```

**Add a chart.**

1. In the HTML, add `<div id="my-chart" class="ec" style="height:300px" role="img" aria-label="What the chart shows"></div>`
   inside a `.chart` `<figure>`, with a `<figcaption>`.
2. In `phase2.js` or `evidence.js`, write `function drawMine() { Charts.draw("my-chart", { /* option */ }, 300); }`.
   Start from the most similar existing chart.
3. Add `drawMine` to the list the script redraws on load and on resize (`drawAll`, or `setMode` if it depends on the staffing case).
4. Rebuild and look at it at desktop and phone width.

**Phones.** Each draw function reads the div's width (`Charts.width(id)`) and changes what it needs below a cut-off: fewer
ticks, shorter labels, row names above the rows. A chart that moves its row names above the rows also sets
`outerBoundsMode: "none"` on its grid. ECharts 6 otherwise shrinks the plot so long labels fit inside the div.

## 8. Try it

```sh
make web && make serve      # then open http://localhost:8000/study.html#p2-worth
```

In the browser's developer console you can inspect or change any chart live:

```js
const c = echarts.getInstanceByDom(document.getElementById("ch-p2-time"));
c.getOption();                                         // the full option, as ECharts expanded it
c.setOption({ series: [{ barWidth: 12 }, { barWidth: 12 }] });   // merged in: thinner bars until the next redraw
```

Edits made this way are lost on reload. When you like the result, copy the setting into the draw function.

## 9. Things that catch people out

- **A blank chart** almost always means the div had no size when it was drawn: no height, or inside something hidden.
- **`setOption` merges by default.** Without the `true` that `Charts.draw` passes, settings from the previous call would stay.
- **Label positions move with the symbol.** If a scatter point has `symbolOffset`, its label already moves with it; don't
  offset the label as well.
- **Formatters must return text.** If a formatter throws, the tooltip quietly does not appear; check the console.

## Further reading

- [Option reference](https://echarts.apache.org/en/option.html): every setting, searchable.
- [Examples gallery](https://echarts.apache.org/examples/en/index.html): find a chart like the one you want, open it, edit its code
  live and copy the option.
- [Handbook](https://echarts.apache.org/handbook/en/get-started/): concepts (datasets, events, themes, accessibility).
