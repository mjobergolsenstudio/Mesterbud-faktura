// api/fiken-draft.js
// Oppretter et FAKTURAUTKAST i Fiken via Fiken v2 REST API.
// Lager ALDRI en ferdig sendt faktura — kun et utkast (draft) som
// håndverkeren selv ser over og sender fra Fiken.
//
// MILJØVARIABLER (sett i Vercel → Settings → Environment Variables):
//   FIKEN_API_TOKEN     = personlig API-token fra kundens Fiken-konto
//   FIKEN_COMPANY_SLUG  = firmaets slug i Fiken (f.eks. "hansen-bygg-as")
//
// Hver kunde har sin egen token + slug. I en flerkunde-oppsett henter du
// disse fra databasen din (f.eks. Supabase) basert på innlogget bruker,
// i stedet for fra miljøvariabler. For første kunde holder env-variabler.

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Kun POST' });

  const TOKEN = process.env.FIKEN_API_TOKEN;
  const SLUG = process.env.FIKEN_COMPANY_SLUG;
  if (!TOKEN || !SLUG) {
    return res.status(500).json({ error: 'Fiken-kobling ikke konfigurert (mangler token/slug)' });
  }

  const { kunde, linjer, fakturatekst, betalingsfrist, fakturadato } = req.body || {};
  if (!linjer || !linjer.length) {
    return res.status(400).json({ error: 'Ingen fakturalinjer mottatt' });
  }

  const base = `https://api.fiken.no/api/v2/companies/${SLUG}`;
  const auth = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  try {
    // 1) Finn eller opprett kunde (kontakt) i Fiken
    let kundeId = null;
    if (kunde && kunde.navn) {
      // Søk etter eksisterende kontakt på navn
      const sok = await fetch(`${base}/contacts?name=${encodeURIComponent(kunde.navn)}`, { headers: auth });
      const treff = sok.ok ? await sok.json() : [];
      if (Array.isArray(treff) && treff.length) {
        kundeId = treff[0].contactId;
      } else {
        // Opprett ny kontakt
        const nyKontakt = await fetch(`${base}/contacts`, {
          method: 'POST', headers: auth,
          body: JSON.stringify({
            name: kunde.navn,
            customer: true,
            phoneNumber: kunde.telefon || undefined,
            address: kunde.adresse ? { address1: kunde.adresse, country: 'NO' } : undefined
          })
        });
        // Fiken returnerer Location-header med ny id
        const loc = nyKontakt.headers.get('location') || '';
        kundeId = loc.split('/').pop() || null;
      }
    }

    // 2) Bygg fakturalinjer. Fiken vil ha beløp i ØRE (×100), inkl. mva.
    const MVA = 'HIGH'; // 25 % utgående mva
    const fikenLinjer = linjer.map(l => {
      const eksMva = Math.round((l.antall || 1) * (l.pris || 0)); // kr eks mva
      const inklMva = Math.round(eksMva * 1.25 * 100);            // øre inkl mva
      return {
        description: l.beskrivelse || 'Arbeid',
        unitPrice: Math.round((l.pris || 0) * 1.25 * 100),        // øre inkl mva per enhet
        quantity: l.antall || 1,
        vatType: MVA,
        incomeAccount: '3000' // standard salgsinntekt; juster ved behov
      };
    });

    const dato = fakturadato || new Date().toISOString().slice(0, 10);
    const forfall = new Date(new Date(dato).getTime() + (betalingsfrist || 14) * 86400000)
      .toISOString().slice(0, 10);

    // 3) Opprett FAKTURAUTKAST (draft) — ikke en ferdig faktura
    const draftBody = {
      type: 'invoice',
      issueDate: dato,
      dueDate: forfall,
      customerId: kundeId ? Number(kundeId) : undefined,
      lines: fikenLinjer,
      bankAccountNumber: undefined, // valgfritt; Fiken bruker firmaets default
      ourReference: 'Mesterbud',
      orderReference: fakturatekst ? fakturatekst.slice(0, 250) : undefined
    };

    const draftRes = await fetch(`${base}/invoices/drafts`, {
      method: 'POST', headers: auth, body: JSON.stringify(draftBody)
    });

    if (!draftRes.ok) {
      const txt = await draftRes.text();
      return res.status(502).json({ error: 'Fiken avviste utkastet', detalj: txt.slice(0, 300) });
    }

    const draftLoc = draftRes.headers.get('location') || '';
    const draftId = draftLoc.split('/').pop();
    return res.status(200).json({ ok: true, draftId, kundeId });

  } catch (e) {
    return res.status(500).json({ error: 'Serverfeil mot Fiken', detalj: String(e).slice(0, 200) });
  }
};
