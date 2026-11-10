// monday has NO standard fields - every board is user-defined columns.
// So we cannot hardcode a mapping; we must introspect. This is the same
// introspection the Board Audit workflow uses.
const c = $('Runtime Config').first().json._cfg;
if (c.crm_provider !== 'monday') return [{ json: { ...$json, _skip_discovery: true } }];
if (!c.monday_board) throw new Error('MONDAY_BOARD_ID not set.');

return [{ json: { ...$json, _req: {
  url: 'https://api.monday.com/v2',
  headers: { 'Content-Type': 'application/json', Authorization: c.crm_token,
             'API-Version': '2024-10' },
  body: { query: `query { boards(ids: [${c.monday_board}]) { id name
            columns { id title type settings_str }
            groups { id title } } }` }
} }}];
