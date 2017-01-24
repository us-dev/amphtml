/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  buildUrl,
  getDetectedPublisherFontFace,
} from './url-builder';
import {makeCorrelator} from '../correlator';
import {getAdCid} from '../../../src/ad-cid';
import {documentInfoForDoc} from '../../../src/document-info';
import {dev} from '../../../src/log';
import {getMode} from '../../../src/mode';
import {isProxyOrigin} from '../../../src/url';
import {viewerForDoc} from '../../../src/viewer';
import {base64UrlDecodeToBytes} from '../../../src/utils/base64';
import {domFingerprint} from '../../../src/utils/dom-fingerprint';
import {createElementWithAttributes} from '../../../src/dom';

/** @const {string} */
const AMP_SIGNATURE_HEADER = 'X-AmpAdSignature';

/** @const {string} */
const CREATIVE_SIZE_HEADER = 'X-CreativeSize';

/** @type {string}  */
const AMP_ANALYTICS_HEADER = 'X-AmpAnalytics';

/** @const {number} */
const MAX_URL_LENGTH = 4096;

/** @enum {string} */
const AmpAdImplementation = {
  AMP_AD_XHR_TO_IFRAME: '2',
  AMP_AD_XHR_TO_IFRAME_OR_AMP: '3',
};

/** @const {!Object} */
export const ValidAdContainerTypes = {
  'AMP-STICKY-AD': 'sa',
  'AMP-FX-FLYING-CARPET': 'fc',
  'AMP-LIGHTBOX': 'lb',
};

/** @const {string} */
export const QQID_HEADER = 'X-QQID';

/**
 * Element attribute that stores experiment IDs.
 *
 * Note: This attribute should be used only for tracking experimental
 * implementations of AMP tags, e.g., by AMPHTML implementors.  It should not be
 * added by a publisher page.
 *
 * @const {!string}
 * @visibleForTesting
 */
export const EXPERIMENT_ATTRIBUTE = 'data-experiment-id';

/** @typedef {{urls: !Array<string>}}
 */
export let AmpAnalyticsConfigDef;

/**
 * Check whether Google Ads supports the A4A rendering pathway is valid for the
 * environment by ensuring native crypto support and page originated in the
 * the {@code cdn.ampproject.org} CDN <em>or</em> we must be running in local
 * dev mode.
 *
 * @param {!Window} win  Host window for the ad.
 * @returns {boolean}  Whether Google Ads should attempt to render via the A4A
 *   pathway.
 */
export function isGoogleAdsA4AValidEnvironment(win) {
  const supportsNativeCrypto = win.crypto &&
      (win.crypto.subtle || win.crypto.webkitSubtle);
  // Note: Theoretically, isProxyOrigin is the right way to do this, b/c it
  // will be kept up to date with known proxies.  However, it doesn't seem to
  // be compatible with loading the example files from localhost.  To hack
  // around that, just say that we're A4A eligible if we're in local dev
  // mode, regardless of origin path.
  return supportsNativeCrypto &&
      (isProxyOrigin(win.location) || getMode().localDev || getMode().test);
}

/**
 * @param {!ArrayBuffer} creative
 * @param {!../../../src/service/xhr-impl.FetchResponseHeaders} responseHeaders
 * @return {!Promise<!../../../extensions/amp-a4a/0.1/amp-a4a.AdResponseDef>}
 */
export function extractGoogleAdCreativeAndSignature(
    creative, responseHeaders) {
  let signature = null;
  let size = null;
  try {
    if (responseHeaders.has(AMP_SIGNATURE_HEADER)) {
      signature =
        base64UrlDecodeToBytes(dev().assertString(
            responseHeaders.get(AMP_SIGNATURE_HEADER)));
    }
    if (responseHeaders.has(CREATIVE_SIZE_HEADER)) {
      const sizeStr = responseHeaders.get(CREATIVE_SIZE_HEADER);
      // We should trust that the server returns the size information in the
      // form of a WxH string.
      size = sizeStr.split('x').map(dim => Number(dim));
    }
  } finally {
    return Promise.resolve(/** @type {
          !../../../extensions/amp-a4a/0.1/amp-a4a.AdResponseDef} */ (
          {creative, signature, size}));
  }
}

/**
 * @param {!../../../extensions/amp-a4a/0.1/amp-a4a.AmpA4A} a4a
 * @param {string} baseUrl
 * @param {number} startTime
 * @param {number} slotNumber
 * @param {!Array<!./url-builder.QueryParameterDef>} queryParams
 * @param {!Array<!./url-builder.QueryParameterDef>} unboundedQueryParams
 * @param {(string|undefined)} clientId
 * @param {string} referrer
 * @return {string}
 */
function buildAdUrl(
    a4a, baseUrl, startTime, slotNumber, queryParams, unboundedQueryParams,
    clientId, referrer) {
  const global = a4a.win;
  const documentInfo = documentInfoForDoc(a4a.element);
  if (!global.gaGlobal) {
    // Read by GPT for GA/GPT integration.
    global.gaGlobal = {
      vid: clientId,
      hid: documentInfo.pageViewId,
    };
  }
  const slotRect = a4a.getIntersectionElementLayoutBox();
  const viewportRect = a4a.getViewport().getRect();
  const iframeDepth = iframeNestingDepth(global);
  const dtdParam = {name: 'dtd'};
  const adElement = a4a.element;

  // Detect container types.
  let parentElement = adElement.parentElement;
  let tagName = parentElement.tagName.toUpperCase();
  const containerTypeSet = {};
  while (parentElement && ValidAdContainerTypes[tagName]) {
    containerTypeSet[ValidAdContainerTypes[tagName]] = true;
    parentElement = parentElement.parentElement;
    tagName = parentElement.tagName.toUpperCase();
  }
  const containerTypeList = [];
  for (const type in containerTypeSet) {
    containerTypeList.push(type);
  }
  if (containerTypeList.length > 0) {
    queryParams.push({name: 'act', value: containerTypeList.join()});
  }

  const fontFace = getDetectedPublisherFontFace(a4a.element);
  if (fontFace) {
    queryParams.push({name: 'dff', value: fontFace});
  }
  const allQueryParams = queryParams.concat(
    [
      {
        name: 'is_amp',
        value: AmpAdImplementation.AMP_AD_XHR_TO_IFRAME_OR_AMP,
      },
      {name: 'amp_v', value: '$internalRuntimeVersion$'},
      {name: 'd_imp', value: '1'},
      {name: 'dt', value: startTime},
      {name: 'adf', value: domFingerprint(adElement)},
      {name: 'c', value: makeCorrelator(clientId, documentInfo.pageViewId)},
      {name: 'output', value: 'html'},
      {name: 'nhd', value: iframeDepth},
      {name: 'eid', value: adElement.getAttribute('data-experiment-id')},
      {name: 'biw', value: viewportRect.width},
      {name: 'bih', value: viewportRect.height},
      {name: 'adx', value: slotRect.left},
      {name: 'ady', value: slotRect.top},
      {name: 'u_hist', value: getHistoryLength(global)},
      {name: 'oid', value: '2'},
      {name: 'ea', value: '0'},
      {name: 'pfx', value: 'fc' in containerTypeSet
        || 'sa' in containerTypeSet},
      dtdParam,
    ],
    unboundedQueryParams,
    [
      {name: 'url', value: documentInfo.canonicalUrl},
      {name: 'top', value: iframeDepth ? topWindowUrlOrDomain(global) : null},
      {
        name: 'loc',
        value: global.location.href == documentInfo.canonicalUrl ?
            null : global.location.href,
      },
      {name: 'ref', value: referrer},
    ]
  );
  dtdParam.value = elapsedTimeWithCeiling(Date.now(), startTime);
  return buildUrl(
      baseUrl, allQueryParams, MAX_URL_LENGTH, {name: 'trunc', value: '1'});
}

/**
 * @param {!Window} win
 * @return {number}
 */
function iframeNestingDepth(win) {
  let w = win;
  let depth = 0;
  while (w != w.parent && depth < 100) {
    w = w.parent;
    depth++;
  }
  dev().assert(w == win.top);
  return depth;
}

/**
 * @param {!Window} win
 * @return {number}
 */
function getHistoryLength(win) {
  // We have seen cases where accessing history length causes errors.
  try {
    return win.history.length;
  } catch (e) {
    return 0;
  }
}

/**
 * @param {!Window} win
 * @return {?string}
 */
function topWindowUrlOrDomain(win) {
  const ancestorOrigins = win.location.ancestorOrigins;
  if (ancestorOrigins) {
    const origin = win.location.origin;
    const topOrigin = ancestorOrigins[ancestorOrigins.length - 1];
    if (origin == topOrigin) {
      return win.top.location.href;
    }
    const secondFromTop = secondWindowFromTop(win);
    if (secondFromTop == win ||
        origin == ancestorOrigins[ancestorOrigins.length - 2]) {
      return secondFromTop./*REVIEW*/document.referrer;
    }
    return topOrigin;
  } else {
    try {
      return win.top.location.href;
    } catch (e) {}
    const secondFromTop = secondWindowFromTop(win);
    try {
      return secondFromTop./*REVIEW*/document.referrer;
    } catch (e) {}
    return null;
  }
}

/**
 * @param {!Window} win
 * @return {!Window}
 */
function secondWindowFromTop(win) {
  let secondFromTop = win;
  let depth = 0;
  while (secondFromTop.parent != secondFromTop.parent.parent &&
        depth < 100) {
    secondFromTop = secondFromTop.parent;
    depth++;
  }
  dev().assert(secondFromTop.parent == win.top);
  return secondFromTop;
}

/**
 * @param {number} time
 * @param {number} start
 * @return {(number|string)}
 */
function elapsedTimeWithCeiling(time, start) {
  const duration = time - start;
  if (duration >= 1e6) {
    return 'M';
  } else if (duration >= 0) {
    return duration;
  }
  return '-M';
}

/**
 * @param {!Window} win
 * @param {string=} opt_cid
 * @return {number} The correlator.
 */
export function getCorrelator(win, opt_cid) {
  if (!win.ampAdPageCorrelator) {
    win.ampAdPageCorrelator = makeCorrelator(
        opt_cid, documentInfoForDoc(win.document).pageViewId);
  }
  return win.ampAdPageCorrelator;
}

/**
 * Collect additional dimensions for the brdim parameter.
 * @param {!Window} win The window for which we read the browser dimensions.
 * @param {{width: number, height: number}|null} viewportSize
 * @return {string}
 * @visibleForTesting
 */
export function additionalDimensions(win, viewportSize) {
  // Some browsers throw errors on some of these.
  let screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight;
  try {
    screenX = win.screenX;
    screenY = win.screenY;
  } catch (e) {}
  try {
    outerWidth = win.outerWidth;
    outerHeight = win.outerHeight;
  } catch (e) {}
  try {
    innerWidth = viewportSize.width;
    innerHeight = viewportSize.height;
  } catch (e) {}
  return [win.screenLeft,
          win.screenTop,
          screenX,
          screenY,
          win.screen ? win.screen.availWidth : undefined,
          win.screen ? win.screen.availTop : undefined,
          outerWidth,
          outerHeight,
          innerWidth,
          innerHeight].join();
};

/**
 * Extracts configuration used to build amp-analytics element for active view.
 *
 * @param {!../../../src/service/xhr-impl.FetchResponseHeaders} responseHeaders
 *   XHR service FetchResponseHeaders object containing the response
 *   headers.
 * @return {?AmpAnalyticsConfigDef} config or null if invalid/missing.
 */
export function extractAmpAnalyticsConfig(responseHeaders) {
  if (responseHeaders.has(AMP_ANALYTICS_HEADER)) {
    try {
      const analyticsConfig =
        JSON.parse(responseHeaders.get(AMP_ANALYTICS_HEADER));
      dev().assert(Array.isArray(analyticsConfig['url']));
      return {urls: analyticsConfig.url};
    } catch (err) {
      dev().error('AMP-A4A', 'Invalid analytics', err,
          responseHeaders.get(AMP_ANALYTICS_HEADER));
    }
  }
  return null;
}

/**
 * Creates amp-analytics element within a4a element using urls specified
 * with amp-ad closest selector and min 50% visible for 1 sec.
 * @param {!../../../extensions/amp-a4a/0.1/amp-a4a.AmpA4A} a4a
 * @param {!../../../src/service/extensions-impl.Extensions} extensions
 * @param {?AmpAnalyticsConfigDef} inputConfig
 */
export function injectActiveViewAmpAnalyticsElement(
    a4a, extensions, inputConfig) {
  if (!inputConfig || !inputConfig.urls.length) {
    return;
  }
  extensions.loadExtension('amp-analytics');
  const ampAnalyticsElem =
    a4a.element.ownerDocument.createElement('amp-analytics');
  ampAnalyticsElem.setAttribute('scoped', '');
  const config = {
    'transport': {'beacon': false, 'xhrpost': false},
    'triggers': {
      'continuousVisible': {
        'on': 'visible',
        'visibilitySpec': {
          'selector': 'amp-ad',
          'selectionMethod': 'closest',
          'visiblePercentageMin': 50,
          'continuousTimeMin': 1000,
        },
      },
    },
  };
  const requests = {};
  const urls = inputConfig.urls;
  for (let idx = 1; idx <= urls.length; idx++) {
    // TODO: Ensure url is valid and not freeform JS?
    requests[`visibility${idx}`] = `${urls[idx - 1]}`;
  }
  // Security review needed here.
  config['requests'] = requests;
  config['triggers']['continuousVisible']['request'] = Object.keys(requests);
  const scriptElem = createElementWithAttributes(
      /** @type {!Document} */(a4a.element.ownerDocument), 'script', {
        'type': 'application/json',
      });
  scriptElem.textContent = JSON.stringify(config);
  ampAnalyticsElem.appendChild(scriptElem);
  a4a.element.appendChild(ampAnalyticsElem);
}
