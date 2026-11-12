// SPDX-License-Identifier: ISC
// Static Lucide 0.468.0 icons; no runtime dependency or network requests.
// Source: https://github.com/lucide-icons/lucide/tree/f12b0de177fbc2a6795e99be065887e72b237123/icons
// Original ISC notice (including Feather attribution): ../LICENSE-lucide.txt
const SVG_NS = 'http://www.w3.org/2000/svg';

// Geometry is copied from the pinned upstream SVGs, never supplied by callers.
const ICON_NODES = Object.freeze({
  "git-pull-request": [
    [
      "circle",
      {
        "cx": "18",
        "cy": "18",
        "r": "3"
      }
    ],
    [
      "circle",
      {
        "cx": "6",
        "cy": "6",
        "r": "3"
      }
    ],
    [
      "path",
      {
        "d": "M13 6h3a2 2 0 0 1 2 2v7"
      }
    ],
    [
      "line",
      {
        "x1": "6",
        "x2": "6",
        "y1": "9",
        "y2": "21"
      }
    ]
  ],
  "git-pull-request-draft": [
    [
      "circle",
      {
        "cx": "18",
        "cy": "18",
        "r": "3"
      }
    ],
    [
      "circle",
      {
        "cx": "6",
        "cy": "6",
        "r": "3"
      }
    ],
    [
      "path",
      {
        "d": "M18 6V5"
      }
    ],
    [
      "path",
      {
        "d": "M18 11v-1"
      }
    ],
    [
      "line",
      {
        "x1": "6",
        "x2": "6",
        "y1": "9",
        "y2": "21"
      }
    ]
  ],
  "circle-check": [
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "10"
      }
    ],
    [
      "path",
      {
        "d": "m9 12 2 2 4-4"
      }
    ]
  ],
  "circle-x": [
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "10"
      }
    ],
    [
      "path",
      {
        "d": "m15 9-6 6"
      }
    ],
    [
      "path",
      {
        "d": "m9 9 6 6"
      }
    ]
  ],
  "loader-circle": [
    [
      "path",
      {
        "d": "M21 12a9 9 0 1 1-6.219-8.56"
      }
    ]
  ],
  "circle-minus": [
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "10"
      }
    ],
    [
      "path",
      {
        "d": "M8 12h8"
      }
    ]
  ],
  "circle-alert": [
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "10"
      }
    ],
    [
      "line",
      {
        "x1": "12",
        "x2": "12",
        "y1": "8",
        "y2": "12"
      }
    ],
    [
      "line",
      {
        "x1": "12",
        "x2": "12.01",
        "y1": "16",
        "y2": "16"
      }
    ]
  ],
  "triangle-alert": [
    [
      "path",
      {
        "d": "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"
      }
    ],
    [
      "path",
      {
        "d": "M12 9v4"
      }
    ],
    [
      "path",
      {
        "d": "M12 17h.01"
      }
    ]
  ],
  "clock-3": [
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "10"
      }
    ],
    [
      "polyline",
      {
        "points": "12 6 12 12 16.5 12"
      }
    ]
  ],
  "scan-search": [
    [
      "path",
      {
        "d": "M3 7V5a2 2 0 0 1 2-2h2"
      }
    ],
    [
      "path",
      {
        "d": "M17 3h2a2 2 0 0 1 2 2v2"
      }
    ],
    [
      "path",
      {
        "d": "M21 17v2a2 2 0 0 1-2 2h-2"
      }
    ],
    [
      "path",
      {
        "d": "M7 21H5a2 2 0 0 1-2-2v-2"
      }
    ],
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "3"
      }
    ],
    [
      "path",
      {
        "d": "m16 16-1.9-1.9"
      }
    ]
  ],
  "message-square-text": [
    [
      "path",
      {
        "d": "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
      }
    ],
    [
      "path",
      {
        "d": "M13 8H7"
      }
    ],
    [
      "path",
      {
        "d": "M17 12H7"
      }
    ]
  ],
  "ellipsis-vertical": [
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "1"
      }
    ],
    [
      "circle",
      {
        "cx": "12",
        "cy": "5",
        "r": "1"
      }
    ],
    [
      "circle",
      {
        "cx": "12",
        "cy": "19",
        "r": "1"
      }
    ]
  ],
  "external-link": [
    [
      "path",
      {
        "d": "M15 3h6v6"
      }
    ],
    [
      "path",
      {
        "d": "M10 14 21 3"
      }
    ],
    [
      "path",
      {
        "d": "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
      }
    ]
  ],
  "rotate-ccw": [
    [
      "path",
      {
        "d": "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
      }
    ],
    [
      "path",
      {
        "d": "M3 3v5h5"
      }
    ]
  ],
  "refresh-cw": [
    [
      "path",
      {
        "d": "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"
      }
    ],
    [
      "path",
      {
        "d": "M21 3v5h-5"
      }
    ],
    [
      "path",
      {
        "d": "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"
      }
    ],
    [
      "path",
      {
        "d": "M8 16H3v5"
      }
    ]
  ],
  "chevron-down": [
    [
      "path",
      {
        "d": "m6 9 6 6 6-6"
      }
    ]
  ],
  "inbox": [
    [
      "polyline",
      {
        "points": "22 12 16 12 14 15 10 15 8 12 2 12"
      }
    ],
    [
      "path",
      {
        "d": "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
      }
    ]
  ]
});

const SVG_ATTRIBUTES = Object.freeze({
  'aria-hidden': 'true',
  focusable: 'false',
  viewBox: '0 0 24 24',
  width: '16',
  height: '16',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
});

/** Return a fresh decorative SVG. Its containing control must provide an accessible label. */
export function icon(name, className = '') {
  if (typeof name !== 'string' || !Object.hasOwn(ICON_NODES, name)) {
    throw new RangeError('Unknown Lucide icon name');
  }
  if (typeof className !== 'string') throw new TypeError('Icon className must be a string');
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [attribute, value] of Object.entries(SVG_ATTRIBUTES)) svg.setAttribute(attribute, value);
  if (className) svg.setAttribute('class', className);
  for (const [tag, attributes] of ICON_NODES[name]) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [attribute, value] of Object.entries(attributes)) child.setAttribute(attribute, value);
    svg.append(child);
  }
  return svg;
}
