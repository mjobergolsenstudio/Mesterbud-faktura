// api/generate-text.js
// Tar et fritekst-jobbnotat og returnerer BÅDE en ryddig fakturatekst
// OG strukturerte fakturalinjer (beskrivelse, antall, pris) som JSON.
//
// Behold din eksisterende Pro/kvote-logikk hvis du vil — den er utelatt
// her for å holde det enkelt, men du kan lime den inn rundt AI-kallet
// akkurat som i originalen.

const Anthropic = require('@anthropic-ai/sdk');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { beskrivelse, firmNavn, pristype } = req.body || {};
  if (!beskrivelse) return res.status(400).json({ error: 'Mangler beskrivelse' });

  const erTime = pristype === 'time';

  // Be modellen om STRUKTURERT JSON — ingen preamble, ingen markdown.
  const systemRegler = `Du er en norsk fakturaassistent for håndverkere. Du får et kort, uformelt jobbnotat og skal trekke ut fakturalinjer.

Returner KUN gyldig JSON, uten markdown, uten forklaring, på dette formatet:
{
  "fakturatekst": "1-2 setningers profesjonell oppsummering av jobben",
  "linjer": [
    { "beskrivelse": "tekst", "antall": tall, "pris": tall }
  ]
}

Regler:
- Hver konkret post i notatet blir en egen linje: arbeid, materialer, kjøring, utstyr osv.
- ${erTime
    ? 'For ARBEID: "antall" = antall timer, "pris" = timepris i kroner. Hvis timepris ikke er oppgitt, bruk 750 som standard timepris.'
    : 'For ARBEID: slå sammen til én fastpris-linje. "antall" = 1, "pris" = samlet arbeidspris hvis oppgitt, ellers timer × 750.'}
- MATERIALER: "antall" = 1, "pris" = materialkostnad i kroner slik notatet oppgir.
- KJØRING: hvis kilometer er nevnt eller kan anslås, "antall" = antall km, "pris" = 5 (kr per km). Hvis bare "kjøring" uten avstand, lag én linje "Kjøring" antall 1 med et rimelig anslag.
- Alle priser er i HELE kroner, eksklusiv mva. Ikke legg til mva — det regnes ut senere.
- Beskrivelser skal være korte og fakturavennlige ("Arbeid – skifte av takstoler", "Materialer", "Kjøring Oslo–Drammen t/r").
- Hvis et tall er uklart, gjør et fornuftig anslag i stedet for å hoppe over linjen.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemRegler,
      messages: [{
        role: 'user',
        content: `Firmanavn: ${firmNavn || 'Ukjent'}\nJobbnotat: "${beskrivelse}"`
      }, {
        role: 'assistant',
        content: '{'
      }]
    });

    let raw = (msg.content[0] && msg.content[0].text || '').trim();
    // Siden vi prefiller med '{', må vi legge den tilbake foran svaret
    if (!raw.startsWith('{')) raw = '{' + raw;
    // Fjern ev. markdown-fences for sikkerhets skyld
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Robust fallback: prøv å trekke ut selve JSON-objektet hvis modellen
      // pakket det inn i tekst (f.eks. "Her er fakturaen: { ... }")
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          parsed = JSON.parse(raw.slice(start, end + 1));
        } catch (e2) {
          parsed = null;
        }
      }
      if (!parsed) {
        // Siste utvei: returner notatet som én linje
        return res.json({
          fakturatekst: beskrivelse,
          linjer: [{ beskrivelse: beskrivelse.slice(0, 80), antall: 1, pris: 0 }]
        });
      }
    }

    // Valider og rens
    const linjer = Array.isArray(parsed.linjer) ? parsed.linjer
      .filter(l => l && (l.beskrivelse || l.pris))
      .map(l => ({
        beskrivelse: String(l.beskrivelse || 'Linje').slice(0, 120),
        antall: Number(l.antall) || 1,
        pris: Math.round(Number(l.pris) || 0)
      })) : [];

    return res.json({
      fakturatekst: String(parsed.fakturatekst || beskrivelse).slice(0, 400),
      linjer: linjer.length ? linjer : [{ beskrivelse: beskrivelse.slice(0, 80), antall: 1, pris: 0 }]
    });

  } catch (e) {
    return res.json({
      fakturatekst: beskrivelse,
      linjer: [{ beskrivelse: beskrivelse.slice(0, 80), antall: 1, pris: 0 }]
    });
  }
};
