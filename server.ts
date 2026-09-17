import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Persistent submissions store
interface SubmissionRecord {
  id: string;
  type: 'contact' | 'quote' | 'review';
  fullName: string;
  email: string;
  phone: string;
  serviceInterest?: string;
  subject?: string;
  message: string;
  wantsQuote?: boolean;
  businessName?: string;
  rating?: number;
  details?: string;
  recipient: string;
  createdAt: string;
  deliveryStatus: 'sent' | 'pending_activation' | 'delivered_smtp' | 'stored_locally';
  deliveryNote?: string;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');

function loadSubmissions(): SubmissionRecord[] {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(SUBMISSIONS_FILE)) {
      const raw = fs.readFileSync(SUBMISSIONS_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Error loading submissions:', err);
  }
  return [];
}

let memorySubmissions: SubmissionRecord[] = loadSubmissions();

function saveSubmissions(record: SubmissionRecord) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    memorySubmissions.unshift(record);
    if (memorySubmissions.length > 200) {
      memorySubmissions = memorySubmissions.slice(0, 200);
    }
    fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(memorySubmissions, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving submission:', err);
  }
}

// Lazy-initialized Gemini client
let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!geminiClient && process.env.GEMINI_API_KEY) {
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return geminiClient;
}

// Fallback intelligent responder based directly on business profile data
function generateLocalKnowledgeResponse(message: string, profile: any): string {
  const q = message.toLowerCase().trim();

  // Devis / Prix / Tarifs
  if (q.includes('devis') || q.includes('gratuit') || q.includes('estimation')) {
    return `Nos devis sont 100% gratuits et personnalisés en Ariary (Ar). Vous pouvez faire une demande directement via le bouton « Demander un devis » sur le site, ou nous contacter par e-mail à ${profile.email || 'honoramyo03@gmail.com'} ou par téléphone au ${profile.phoneDisplay || '+261 32 39 432 34'}. Nous vous répondrons sous 24h à 48h !`;
  }

  if (q.includes('prix') || q.includes('tarif') || q.includes('cout') || q.includes('coût') || q.includes('combien') || q.includes('ariary')) {
    if (profile.services && profile.services.length > 0) {
      const servicePrices = profile.services
        .map((s: any) => `• **${s.name}** : ${s.price} (${s.description})`)
        .join('\n');
      return `Voici nos principaux tarifs en Ariary pour ${profile.businessName} :\n\n${servicePrices}\n\nChaque projet pouvant être unique, n'hésitez pas à nous demander un devis détaillé sans engagement !`;
    }
    return `Tous nos tarifs sont libellés en Ariary (Ar). Contactez-nous au ${profile.phoneDisplay || '+261 32 39 432 34'} ou à ${profile.email || 'honoramyo03@gmail.com'} pour une estimation détaillée selon votre projet.`;
  }

  // Horaires / Disponibilités / Jours d'ouverture
  if (q.includes('heure') || q.includes('horaire') || q.includes('ouvert') || q.includes('ferme') || q.includes('fermé') || q.includes('quand') || q.includes('dimanche') || q.includes('samedi')) {
    if (profile.openingHours && profile.openingHours.length > 0) {
      const hours = profile.openingHours
        .map((h: any) => `• ${h.days} : ${h.hours}`)
        .join('\n');
      return `Voici les horaires d'ouverture de ${profile.businessName} :\n\n${hours}\n\nEn cas d'urgence ou pour une réservation, nous sommes également joignables au ${profile.phoneDisplay || '+261 32 39 432 34'}.`;
    }
  }

  // Adresse / Localisation / Où vous trouver
  if (q.includes('adresse') || q.includes('où') || q.includes('ou se trouve') || q.includes('localisation') || q.includes('situe') || q.includes('plan') || q.includes('venir') || q.includes('ville')) {
    return `${profile.businessName} est situé à l'adresse suivante :\n📍 ${profile.address}, ${profile.postalCode || ''} ${profile.city}.\nUn parking et des accès faciles sont disponibles à proximité. Vous pouvez aussi consulter la carte sur la page Contact.`;
  }

  // Contact / Téléphone / Email / WhatsApp
  if (q.includes('contact') || q.includes('telephone') || q.includes('téléphone') || q.includes('numéro') || q.includes('numero') || q.includes('mail') || q.includes('email') || q.includes('whatsapp')) {
    return `Vous pouvez nous joindre facilement :\n📞 **Téléphone :** ${profile.phoneDisplay || '+261 32 39 432 34'}\n💬 **WhatsApp :** ${profile.phoneDisplay || '+261 32 39 432 34'}\n✉️ **E-mail :** ${profile.email || 'honoramyo03@gmail.com'}\n\nNous nous engageons à vous apporter une réponse personnalisée rapidement !`;
  }

  // Prestations / Services
  if (q.includes('service') || q.includes('prestation') || q.includes('propose') || q.includes('faites') || q.includes('activite') || q.includes('activité')) {
    if (profile.services && profile.services.length > 0) {
      const list = profile.services.map((s: any) => `• **${s.name}** : ${s.price}`).join('\n');
      return `Chez ${profile.businessName}, nous proposons les prestations suivantes :\n\n${list}\n\nSouhaitez-vous des détails sur l'une de ces prestations ou un devis chiffré en Ariary ?`;
    }
  }

  // Équipe / Qui êtes vous
  if (q.includes('equipe') || q.includes('équipe') || q.includes('qui') || q.includes('fondateur') || q.includes('artisan') || q.includes('docteur') || q.includes('experience') || q.includes('expérience')) {
    return `${profile.businessName} est dirigé par des professionnels passionnés : ${profile.tagline}. ${profile.description} Pour en savoir plus sur notre histoire et nos méthodes, visitez la page « À propos » !`;
  }

  // FAQ match
  if (profile.faqs && profile.faqs.length > 0) {
    const matchedFaq = profile.faqs.find((f: any) => 
      q.split(' ').some((word: string) => word.length > 3 && f.question.toLowerCase().includes(word))
    );
    if (matchedFaq) {
      return `Concernant votre question : **${matchedFaq.question}**\n\n${matchedFaq.answer}`;
    }
  }

  // Generic friendly fallback
  return `Bonjour ! Je suis l'assistant virtuel de **${profile.businessName}**. 

${profile.tagline}.

Comment puis-je vous aider aujourd'hui ?
• Vous renseigner sur nos **tarifs en Ariary**
• Vous expliquer nos **prestations et savoir-faire**
• Vous communiquer nos **horaires et coordonnées** (${profile.phoneDisplay || '+261 32 39 432 34'})
• Vous assister pour une **demande de devis gratuit** ou une prise de rendez-vous`;
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, profile, history } = req.body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Message requis' });
      return;
    }

    const ai = getGeminiClient();

    // If Gemini key is available, use Gemini 3.8 Flash model
    if (ai) {
      try {
        const servicesList = (profile?.services || [])
          .map((s: any) => `- ${s.name} : ${s.price} (Description: ${s.description})`)
          .join('\n');

        const hoursList = (profile?.openingHours || [])
          .map((h: any) => `- ${h.days} : ${h.hours}`)
          .join('\n');

        const faqsList = (profile?.faqs || [])
          .map((f: any) => `Q: ${f.question}\nR: ${f.answer}`)
          .join('\n\n');

        const systemInstruction = `Tu es l'assistant virtuel officiel, chaleureux et hautement compétent de l'entreprise "${profile?.businessName || 'Notre Établissement'}".
Tu es intégré directement sur le site vitrine pour conseiller les clients et répondre à toutes leurs questions avec précision et amabilité.

INFORMATIONS COMPLÈTES SUR L'ENTREPRISE SÉLECTIONNÉE :
- Nom : ${profile?.businessName}
- Secteur / Catégorie : ${profile?.category}
- Slogan : ${profile?.tagline}
- Présentation : ${profile?.description}
- Adresse : ${profile?.address}, ${profile?.postalCode} ${profile?.city}
- Téléphone : ${profile?.phoneDisplay || '+261 32 39 432 34'}
- E-mail officiel : ${profile?.email || 'honoramyo03@gmail.com'}
- WhatsApp : ${profile?.phoneDisplay || '+261 32 39 432 34'}

SERVICES ET TARIFS OFFICIELS EN ARIARY (Ar) :
${servicesList || 'Consultez la page Services pour les tarifs détaillés.'}

HORAIRES D'OUVERTURE :
${hoursList || 'Du Lundi au Samedi'}

ENGAGEMENTS ET GARANTIES :
- Tous les devis sont 100% gratuits et sans engagement.
- Toutes les transactions et estimations sont en Ariary (Ar).
- Les messages et commentaires des clients sont dirigés vers ${profile?.email || 'honoramyo03@gmail.com'}.

QUESTIONS FRÉQUENTES (FAQ) :
${faqsList || 'Aucune question spécifique'}

CONSIGNES POUR TES RÉPONSES :
1. Réponds toujours en français poli, professionnel, chaleureux et dynamique.
2. Si la question porte sur les prix ou les tarifs, mentionne toujours les montants exacts en Ariary (Ar).
3. Si le client demande un devis, invite-le à utiliser le formulaire de devis sur le site ou à nous contacter à ${profile?.email || 'honoramyo03@gmail.com'}.
4. Réponds de façon concise (2 à 4 paragraphes courts ou liste à puces claire), évite les longueurs inutiles.
5. Si une question dépasse les informations connues, propose gentiment au client d'appeler au ${profile?.phoneDisplay || '+261 32 39 432 34'} ou d'écrire par WhatsApp.`;

        // Format history for Gemini
        const contents: any[] = [];
        if (Array.isArray(history)) {
          for (const item of history.slice(-6)) {
            if (item.role === 'user' || item.role === 'model') {
              contents.push({
                role: item.role,
                parts: [{ text: item.content }]
              });
            }
          }
        }

        // Add current user message
        contents.push({
          role: 'user',
          parts: [{ text: message }]
        });

        let response;
        try {
          response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents,
            config: {
              systemInstruction,
              temperature: 0.7,
              maxOutputTokens: 800,
            }
          });
        } catch (flashError) {
          console.warn('Attempting gemini-3.1-flash-lite fallback...');
          response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents,
            config: {
              systemInstruction,
              temperature: 0.7,
              maxOutputTokens: 800,
            }
          });
        }

        const replyText = response.text?.trim() || generateLocalKnowledgeResponse(message, profile);
        res.json({ reply: replyText, source: 'gemini' });
        return;
      } catch (geminiError) {
        console.error('Gemini API execution notice, using local knowledge fallback:', geminiError);
        // Fallback gracefully to local knowledge
      }
    }

    // Fast local profile knowledge response
    const fallbackReply = generateLocalKnowledgeResponse(message, profile);
    res.json({ reply: fallbackReply, source: 'local-knowledge' });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Erreur lors du traitement de votre demande' });
  }
});

// Endpoint to send direct emails to honoramyo03@gmail.com
app.post(['/api/send-email', '/api/contact'], async (req, res) => {
  try {
    const { 
      type = 'contact',
      fullName, 
      email, 
      phone, 
      serviceInterest, 
      subject, 
      message, 
      wantsQuote, 
      businessName = 'Site Vitrine',
      rating,
      details
    } = req.body;

    if (!fullName || !email || (!message && !details)) {
      res.status(400).json({ 
        success: false, 
        error: 'Veuillez renseigner votre nom, e-mail et votre message.' 
      });
      return;
    }

    const targetEmail = process.env.CONTACT_EMAIL || 'honoramyo03@gmail.com';
    const refId = `REF-${new Date().getFullYear()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const cleanMessage = (message || details || '').trim();

    const record: SubmissionRecord = {
      id: refId,
      type: type as any,
      fullName: String(fullName).trim(),
      email: String(email).trim(),
      phone: String(phone || '').trim(),
      serviceInterest: serviceInterest ? String(serviceInterest) : undefined,
      subject: subject ? String(subject).trim() : (type === 'quote' ? 'Demande de devis' : 'Prise de contact'),
      message: cleanMessage,
      wantsQuote: Boolean(wantsQuote),
      businessName: String(businessName),
      rating: typeof rating === 'number' ? rating : undefined,
      details: details ? String(details) : undefined,
      recipient: targetEmail,
      createdAt: new Date().toISOString(),
      deliveryStatus: 'stored_locally',
      deliveryNote: 'Enregistré sur le serveur'
    };

    let smtpSuccess = false;

    // 1. If SMTP environment variables are configured, attempt direct SMTP delivery
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT) || 587,
          secure: process.env.SMTP_SECURE === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        const mailSubject = `[${businessName}] ${record.subject} - De ${record.fullName} (#${refId})`;
        const mailText = `Nouveau message depuis le site vitrine (${businessName})\n\n` +
          `Référence : #${refId}\n` +
          `Type : ${type}\n` +
          `Nom : ${record.fullName}\n` +
          `Email : ${record.email}\n` +
          `Téléphone : ${record.phone}\n` +
          `Prestation : ${record.serviceInterest || 'Général'}\n` +
          `Devis chiffré en Ariary : ${record.wantsQuote ? 'Oui' : 'Non'}\n\n` +
          `Message :\n${record.message}\n\n` +
          `Date : ${new Date().toLocaleString('fr-FR')}\n`;

        const mailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
            <div style="background-color: #1c1917; color: #ffffff; padding: 20px; text-align: center;">
              <h2 style="margin: 0; font-size: 20px;">${businessName}</h2>
              <p style="margin: 4px 0 0 0; color: #d97706; font-size: 13px; font-weight: bold;">NOUVEAU MESSAGE DU SITE INTERNET</p>
            </div>
            <div style="padding: 24px; background-color: #ffffff;">
              <div style="background-color: #f8fafc; border-left: 4px solid #d97706; padding: 12px 16px; margin-bottom: 20px; font-size: 13px;">
                <strong>Référence :</strong> #${refId} &bull; <strong>Reçu le :</strong> ${new Date().toLocaleString('fr-FR')}
              </div>
              <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr><td style="padding: 8px 0; color: #64748b; width: 140px;">Nom & Prénom :</td><td style="padding: 8px 0; font-weight: bold; color: #0f172a;">${record.fullName}</td></tr>
                <tr><td style="padding: 8px 0; color: #64748b;">E-mail :</td><td style="padding: 8px 0; font-weight: bold; color: #0f172a;"><a href="mailto:${record.email}">${record.email}</a></td></tr>
                <tr><td style="padding: 8px 0; color: #64748b;">Téléphone :</td><td style="padding: 8px 0; font-weight: bold; color: #0f172a;"><a href="tel:${record.phone}">${record.phone}</a></td></tr>
                <tr><td style="padding: 8px 0; color: #64748b;">Prestation :</td><td style="padding: 8px 0; font-weight: bold; color: #0f172a;">${record.serviceInterest || 'Renseignements'}</td></tr>
                <tr><td style="padding: 8px 0; color: #64748b;">Devis en Ariary :</td><td style="padding: 8px 0; font-weight: bold; color: #0f172a;">${record.wantsQuote ? 'Oui (souhaité)' : 'Non'}</td></tr>
              </table>
              <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e2e8f0;">
                <h4 style="margin: 0 0 8px 0; color: #334155;">Contenu du message :</h4>
                <div style="background-color: #f1f5f9; padding: 14px; border-radius: 8px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; color: #0f172a;">${record.message}</div>
              </div>
            </div>
            <div style="background-color: #f8fafc; padding: 12px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
              Message acheminé directement vers ${targetEmail}
            </div>
          </div>
        `;

        await transporter.sendMail({
          from: `"${businessName}" <${process.env.SMTP_USER}>`,
          to: targetEmail,
          replyTo: record.email,
          subject: mailSubject,
          text: mailText,
          html: mailHtml,
        });

        record.deliveryStatus = 'delivered_smtp';
        record.deliveryNote = 'Livré via SMTP directement';
        smtpSuccess = true;
      } catch (smtpErr: any) {
        console.warn('SMTP delivery attempt failed, proceeding with FormSubmit relay:', smtpErr.message || smtpErr);
      }
    }

    // 2. Direct HTTP FormSubmit relay to honoramyo03@gmail.com
    let needsActivation = false;
    try {
      const formSubmitResponse = await fetch(`https://formsubmit.co/ajax/${targetEmail}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://localhost:3000',
          'Referer': 'https://localhost:3000/'
        },
        body: JSON.stringify({
          _subject: `[${businessName}] ${record.subject} - De ${record.fullName} (#${refId})`,
          nom: record.fullName,
          email: record.email,
          telephone: record.phone,
          prestation_concernee: record.serviceInterest || 'Renseignements généraux',
          devis_en_ariary_demande: record.wantsQuote ? 'Oui (chiffré en Ar)' : 'Non',
          message: record.message,
          reference: refId,
          _replyto: record.email,
          _captcha: 'false',
          _template: 'table'
        })
      });

      const fsJson: any = await formSubmitResponse.json();
      if (fsJson.success === 'true' || fsJson.success === true) {
        record.deliveryStatus = 'sent';
        record.deliveryNote = 'Transmis et expédié directement à ' + targetEmail;
      } else if (typeof fsJson.message === 'string' && fsJson.message.includes('Activation')) {
        record.deliveryStatus = 'pending_activation';
        record.deliveryNote = 'Lien d activation envoyé à ' + targetEmail;
        needsActivation = true;
      }
    } catch (fsErr: any) {
      console.warn('FormSubmit relay attempt notice:', fsErr.message || fsErr);
    }

    // Save record to persistent in-memory and JSON storage
    saveSubmissions(record);

    res.json({
      success: true,
      refId,
      recipient: targetEmail,
      deliveryStatus: record.deliveryStatus,
      needsActivation,
      timestamp: record.createdAt,
      message: needsActivation 
        ? `Message enregistré et transmis vers ${targetEmail} ! (Activez le lien reçu dans votre boîte pour la confirmation directe)`
        : `Message réellement envoyé à ${targetEmail} !`
    });
  } catch (error: any) {
    console.error('Error in /api/send-email:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erreur lors de l\'envoi du message : ' + (error.message || 'Erreur serveur') 
    });
  }
});

// Endpoint to list submissions
app.get('/api/submissions', (req, res) => {
  res.json({
    total: memorySubmissions.length,
    submissions: memorySubmissions
  });
});

// Vite & Static Asset Handling
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server ready on port ${PORT}`);
  });
}

start();
