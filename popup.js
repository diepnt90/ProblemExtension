// ===== Helper: extract and normalize the resourceId from an Azure Portal URL =====
function parseAzureResourceFromUrl(urlStr) {
  let subid = "", appplan = "", webapp = "", slot = "", kind = ""; // kind: sites|serverfarms
  try {
    const u = new URL(urlStr);
    const hash = u.hash || "";

    let resourceIdDecoded = "";

    // 1) Case plaintext: ...#@tenant/resource/subscriptions/...
    const mPlain = hash.match(/\/resource(\/subscriptions\/[^?#]+)/i);
    if (mPlain && mPlain[1]) {
      resourceIdDecoded = mPlain[1];
    } else {
      // 2) Case Metrics: .../ResourceId/%2Fsubscriptions%2F...
      const mEnc = hash.match(/ResourceId\/([^/]+)(?=\/|$)/i);
      if (mEnc && mEnc[1]) {
        resourceIdDecoded = decodeURIComponent(mEnc[1]);
      } else {
        // 3) Fallback: decode the whole hash, then search again
        try {
          const decodedHash = decodeURIComponent(hash);
          const mAny = decodedHash.match(/\/subscriptions\/[^?#]+/i);
          if (mAny) resourceIdDecoded = mAny[0];
        } catch (_) { /* ignore */ }
      }
    }

    // 3.b) TRIM the trailing extras (appServices, TimeContext~/..., Chart~/..., ...)
    if (resourceIdDecoded) {
      const baseMatch = resourceIdDecoded.match(
        /(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/(?:sites|serverfarms)\/[^/]+(?:\/slots\/[^/]+)?)/i
      );
      if (baseMatch) {
        resourceIdDecoded = baseMatch[1];
      }
    }

    // 4) Parse the normalized resourceId
    if (resourceIdDecoded) {
      const m = resourceIdDecoded.match(
        /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Web\/(sites|serverfarms)\/([^/]+)(?:\/slots\/([^/]+))?$/i
      );
      if (m) {
        subid   = m[1];
        appplan = m[2];     // Resource Group
        kind    = m[3];     // 'sites' | 'serverfarms'
        webapp  = m[4];     // site name or app service plan name
        slot    = m[5] || "";
      }
    }

    // 5) Fallback if still empty
    if (!subid) {
      const m2 = urlStr.match(
        /%2Fsubscriptions%2F([^/%]+)%2FresourceGroups%2F([^/%]+)%2Fproviders%2FMicrosoft\.Web%2F(sites|serverfarms)%2F([^/%]+)(?:%2Fslots%2F([^/%]+))?/i
      );
      if (m2) {
        subid   = m2[1];
        appplan = m2[2];
        kind    = m2[3];
        webapp  = m2[4];
        slot    = m2[5] || "";
      }
    }
  } catch (_) {}
  return { subid, appplan, webapp, slot, kind };
}

// ===== Helper: force consoleUrl onto the slot's own SCM host =====
function slotAwareConsoleUrl(consoleUrl, webapp, slot) {
  if (!consoleUrl || !slot) return consoleUrl;
  try {
    const u = new URL(consoleUrl);
    const prodPrefix = `${webapp}.`.toLowerCase();
    if (u.hostname.toLowerCase().startsWith(prodPrefix)) {
      u.hostname = `${webapp}-${slot}${u.hostname.slice(webapp.length)}`;
      return u.toString();
    }
  } catch (_) { /* ignore */ }
  return consoleUrl;
}

function notify(message, kind) {
  const el = document.getElementById("notice");
  if (!el) return;
  el.textContent = message;
  el.className = kind === "ok" ? "ok" : "";
  el.hidden = false;
}

function getAuthToken() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    try {
      chrome.runtime.sendMessage({ type: "GET_TOKEN" }, (res) => {
        if (chrome.runtime.lastError || !res) {
          chrome.storage.session.get(["azureAuthToken", "azureAuthTokenAt"]).then((d) => {
            done({ token: d.azureAuthToken || "", at: d.azureAuthTokenAt || 0, expired: false });
          }, () => done({ token: "", at: 0, expired: false }));
          return;
        }
        done(res);
      });
    } catch (_) {
      done({ token: "", at: 0, expired: false });
    }
  });
}

// ===== Standalone tool shortcuts =====
const openHttper = document.getElementById("open-httper");
if (openHttper) {
  openHttper.addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("httper.html") });
  });
}

const openCsvLog = document.getElementById("open-csv-log");
if (openCsvLog) {
  openCsvLog.addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("csv-log.html") });
  });
}

// ===== Main logic =====
chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  var url = (tabs && tabs[0] && tabs[0].url) ? tabs[0].url : "";
  var { subid, appplan, webapp, slot, kind } = parseAzureResourceFromUrl(url);

  if (!subid || !appplan || !webapp) {
    notify("Could not read a ResourceId from the current URL. Open the resource page (Response Time chart or the resource blade) and try again.");
    return;
  }

  getAuthToken().then(function (auth) {
    const result = auth && auth.token ? auth.token : "";

    if (!result.startsWith("Bearer ")) {
      notify("Please refresh the tab and go to the response time chart first to get the extension working.");
      return;
    }
    if (auth.expired) {
      notify("The token may have expired. If the API returns 401, refresh the Azure Portal tab and reopen this panel.");
    }

    const authElement = document.getElementById("authorization-value");
    if (authElement) authElement.textContent = "Auth: ok";

    const subidElement = document.getElementById("subid");
    subidElement.textContent = `Subscription ID: ${subid}`;
    const appplanElement = document.getElementById("appplan");
    appplanElement.textContent = `App Plan: ${appplan}`;
    const webappElement = document.getElementById("webapp");
    webappElement.textContent = slot ? `Web App: ${webapp} (slot: ${slot})` : `Web App: ${webapp}`;

    const sitePath = `/subscriptions/${subid}/resourceGroups/${appplan}/providers/Microsoft.Web/sites/${webapp}`
      + (slot ? `/slots/${slot}` : "");

    const dropdownElement = document.getElementById("machine-names");
    const replaceButton = document.getElementById("replace-button");
    const goToKuduButton = document.getElementById("go-to-kudu-button");
    const takeTrace = document.getElementById("take-trace");
    const takeDump = document.getElementById("take-dump");
    const masterScript = document.getElementById("master-script");
    const logFiles = document.getElementById("log-files");
    const aiQuery = document.getElementById("ai-query");
    const threadPool = document.getElementById("threadpool-script");

    fetch(`https://management.azure.com${sitePath}/instances?api-version=2020-12-01`, {
      headers: {
        'Authorization': result,
        'Content-Type': 'application/json'
      }
    })
    .then(response => {
      if (response.status === 401 || response.status === 403) {
        throw new Error("expired");
      }
      return response.json();
    })
    .then(data => {
      const machineNames = (data.value || []).map(instance => instance.properties.machineName);
      machineNames.forEach(name => {
        const option = document.createElement('option');
        option.text = name;
        dropdownElement.appendChild(option);
      });

      replaceButton.addEventListener("click", function () {
        const selectedMachineName = dropdownElement.value;
        if (selectedMachineName) {
          fetch(`https://management.azure.com/subscriptions/${subid}/resourceGroups/${appplan}/providers/Microsoft.Web/serverfarms/${webapp}/workers/${selectedMachineName}/reboot?api-version=2022-03-01`, {
            method: "POST",
            headers: {
              'Authorization': result,
              'Content-Type': 'application/json'
            }
          })
          .then(response => {
            if (response.status >= 200 && response.status < 300) {
              notify(`Machine ${selectedMachineName} is replaced.`, "ok");
            } else {
              response.text().then(error => {
                notify(`Error replacing machine ${selectedMachineName}: ${error}`);
              });
            }
          })
          .catch(error => {
            console.error('Error replacing machine:', error);
          });
        } else {
          notify("Please select a machine to replace.");
        }
      });

      goToKuduButton.addEventListener("click", function () {
        const selectedMachineName = dropdownElement.value;
        if (selectedMachineName) {
          const instance = (data.value || []).find(x => x.properties && x.properties.machineName === selectedMachineName);
          if (instance && instance.properties.consoleUrl) {
            let kuduUrl = slotAwareConsoleUrl(instance.properties.consoleUrl, webapp, slot).replace("webssh/host", "newui/env");
            if (kuduUrl.includes('?')) kuduUrl += '&hideSecrets=false';
            else kuduUrl += '?hideSecrets=false';
            chrome.tabs.create({ url: kuduUrl });
          } else {
            notify(`Console URL not found for machine ${selectedMachineName}`);
          }
        } else {
          notify("Please select a machine.");
        }
      });

      aiQuery.addEventListener("click", function () {
        const resourceUrl = `https://portal.azure.com/#@episerver.net/resource/subscriptions/${subid}/resourceGroups/${appplan}/providers/microsoft.insights/components/${webapp}/logs`;
        const scriptText = `//Top domain query
requests
| extend urlParts = parseurl(url)
| extend hostname = urlParts.Host
| summarize sum(itemCount) by tostring(hostname), bin(timestamp, 1m)
| render timechart

//List requests by time
requests
| where timestamp > datetime(2025-03-31T11:00:00) and timestamp < datetime(2025-03-31T12:00:00) and name !contains "bus"
| project timestamp, id, name, url, performanceBucket, resultCode, cloud_RoleInstance
| sort by timestamp asc

//Check abnormal operation
requests
| where timestamp > datetime(2024-03-25T16:00:00) and timestamp < datetime(2024-03-25T17:00:00)
| summarize sum(itemCount) by operation_Name, bin(timestamp, 1m)
| render timechart

//View operation by columnchart
requests
| where timestamp > datetime(2025-03-31T11:00:00) and timestamp < datetime(2025-03-31T12:00:00) and name !contains "bus"
| top-nested 100 of bin(timestamp, 1m) by count(),
top-nested 10 of name by sum(itemCount)
| project timestamp, name, c=aggregated_name
| order by timestamp asc
| render columnchart`;
        const tempInput = document.createElement("textarea");
        tempInput.value = scriptText;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
        chrome.tabs.create({ url: resourceUrl });
      });

      takeTrace.addEventListener("click", function () {
        const selectedMachineName = dropdownElement.value;
        if (selectedMachineName) {
          const instance = (data.value || []).find(x => x.properties && x.properties.machineName === selectedMachineName);
          if (instance && instance.properties.consoleUrl) {
            const kuduUrl = slotAwareConsoleUrl(instance.properties.consoleUrl, webapp, slot).replace("webssh/host?instance=", "ssh?target=app&instance=");
            const scriptText = "curl -o script.sh https://raw.githubusercontent.com/diepnt90/getdumptrace/refs/heads/main/script.sh && chmod +x script.sh && ./script.sh --trace";
            const tempInput = document.createElement("textarea");
            tempInput.value = scriptText;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand("copy");
            document.body.removeChild(tempInput);
            chrome.tabs.create({ url: kuduUrl });
          } else {
            notify(`Console URL not found for machine ${selectedMachineName}`);
          }
        } else {
          notify("Please select a machine.");
        }
      });

      takeDump.addEventListener("click", function () {
        const selectedMachineName = dropdownElement.value;
        if (selectedMachineName) {
          const instance = (data.value || []).find(x => x.properties && x.properties.machineName === selectedMachineName);
          if (instance && instance.properties.consoleUrl) {
            const kuduUrl = slotAwareConsoleUrl(instance.properties.consoleUrl, webapp, slot).replace("webssh/host?instance=", "ssh?target=app&instance=");
            const scriptText = "curl -o script.sh https://raw.githubusercontent.com/diepnt90/getdumptrace/refs/heads/main/script.sh && chmod +x script.sh && ./script.sh --dump";
            const tempInput = document.createElement("textarea");
            tempInput.value = scriptText;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand("copy");
            document.body.removeChild(tempInput);
            chrome.tabs.create({ url: kuduUrl });
          } else {
            notify(`Console URL not found for machine ${selectedMachineName}`);
          }
        } else {
          notify("Please select a machine.");
        }
      });

      masterScript.addEventListener("click", function () {
        const selectedMachineName = dropdownElement.value;
        if (selectedMachineName) {
          const instance = (data.value || []).find(x => x.properties && x.properties.machineName === selectedMachineName);
          if (instance && instance.properties.consoleUrl) {
            const kuduUrl = slotAwareConsoleUrl(instance.properties.consoleUrl, webapp, slot).replace("webssh/host?instance=", "ssh?target=app&instance=");
            const scriptText = "curl -o script.sh https://raw.githubusercontent.com/diepnt90/MasterScript01/refs/heads/main/script.sh && chmod +x script.sh && ./script.sh";
            const tempInput = document.createElement("textarea");
            tempInput.value = scriptText;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand("copy");
            document.body.removeChild(tempInput);
            chrome.tabs.create({ url: kuduUrl });
          } else {
            notify(`Console URL not found for machine ${selectedMachineName}`);
          }
        } else {
          notify("Please select a machine.");
        }
      });

      threadPool.addEventListener("click", function () {
        const selectedMachineName = dropdownElement.value;
        if (selectedMachineName) {
          const instance = (data.value || []).find(x => x.properties && x.properties.machineName === selectedMachineName);
          if (instance && instance.properties.consoleUrl) {
            const kuduUrl = slotAwareConsoleUrl(instance.properties.consoleUrl, webapp, slot).replace("webssh/host?instance=", "ssh?target=app&instance=");
            const scriptText = "curl -o Threadpool_script.sh https://raw.githubusercontent.com/diepnt90/threadpoolscript/refs/heads/main/Threadpool_script.sh && chmod +x Threadpool_script.sh && ./Threadpool_script.sh";
            const tempInput = document.createElement("textarea");
            tempInput.value = scriptText;
            document.body.appendChild(tempInput);
            tempInput.select();
            document.execCommand("copy");
            document.body.removeChild(tempInput);
            chrome.tabs.create({ url: kuduUrl });
          } else {
            notify(`Console URL not found for machine ${selectedMachineName}`);
          }
        } else {
          notify("Please select a machine.");
        }
      });

      logFiles.addEventListener("click", function () {
        const selectedMachineName = dropdownElement.value;
        if (selectedMachineName) {
          const instance = (data.value || []).find(x => x.properties && x.properties.machineName === selectedMachineName);
          if (instance && instance.properties.consoleUrl) {
            let kuduUrl = slotAwareConsoleUrl(instance.properties.consoleUrl, webapp, slot).replace("webssh/host", "api/zip/LogFiles/");
            chrome.tabs.create({ url: kuduUrl });
          } else {
            notify(`Console URL not found for machine ${selectedMachineName}`);
          }
        } else {
          notify("Please select a machine.");
        }
      });

    })
    .catch(error => {
      console.error('Error fetching machine names:', error);
      if (error && error.message === "expired") {
        notify("Token expired (401). Refresh the Azure Portal tab, reopen the Response Time chart and try again.");
      } else {
        notify(`Could not fetch the instance list: ${error && error.message ? error.message : error}`);
      }
    });
  });
});