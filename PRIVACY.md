# Inductive search（感应式搜索）privacy policy

Inductive search is a browser extension that finds the paragraph on a web page that answers a question you type. This page describes what it does with data.

## What is sent, and when

When you explicitly submit a search while the Inductive search bar is open, text from the selected scope (whole page, article or current selection), your query and any conditions are sent to your selected provider: TypeSafe AI (`api.typesafe.ai`), OpenRouter (`openrouter.ai`) or OpenLux (`api.openlux.ai`). All routes use Jev to score each paragraph. Nothing is sent before you open the bar, and nothing is sent from pages where you have not opened it. Closing the bar cancels the client request. Requests already received by the provider may still be processed or billed. Typing alone does not submit a search.

The page's URL and title are included with the text so the model has context. Your API key is sent in the request's authorization header.

TypeSafe's handling of that data is governed by their own policies at <https://typesafe.ai/legal/privacy-policy>. When you choose OpenRouter, requests go through OpenRouter to TypeSafe; OpenRouter's policy is at <https://openrouter.ai/privacy>. Inductive search has no server of its own.

When you choose OpenLux, requests go to OpenLux for relay to the model provider. OpenLux's policy is at <https://www.openlux.ai/policies/privacy>.

The settings page also requests the selected provider's model list. OpenRouter's public model list is fetched without your key or page content. TypeSafe's model list uses your TypeSafe key. OpenLux's model choices are local and do not make a model-list request.

## What is stored

Your API keys and chosen models are stored separately for each provider in the browser's extension storage on your device. They are not synced anywhere by Inductive search. A key is only sent to the provider it belongs to. Switching providers does not copy a key to the other provider.

Saved excerpts include only the original text you choose to save, page title and URL, section heading, search query or conditions, scope and saving time. They stay in extension local storage until you delete them or uninstall the extension. They are not sent along with later searches and are not synced to a cloud service. Copy and Markdown export happen only when you click those actions.

The excerpt sidebar uses a closed shadow root so ordinary page scripts cannot read saved excerpts through the host page DOM. Do not save sensitive excerpts on shared browser profiles.

## What is not collected

Inductive search has no analytics, no telemetry, no crash reporting, no accounts, and no tracking. It does not read your browsing history, other tabs, cookies, or form contents. It does not run on pages you have not opened it on.

## Permissions

- **Access to `api.typesafe.ai`, `openrouter.ai` and `api.openlux.ai`**: to send searches to the selected provider and list its models where needed.
- **Active tab and scripting**: to read the text of the page you invoked Inductive search on and draw the highlights.
- **Storage**: to keep your key and model choice.

## Contact

Questions about this policy: open an issue at <https://github.com/knockkeykey/inductive-search/issues>.
