const categories = [
  'Royalty & Payments',
  'ISBN & Metadata Issues',
  'Printing & Quality',
  'Distribution & Availability',
  'Book Status & Production Updates',
  'General Inquiry',
];
const priorities = ['Critical', 'High', 'Medium', 'Low'];

const knowledge = {
  royalty: 'Royalties use an 80/20 split of net profit after printing, platform commission and shipping. They are calculated quarterly and paid within 45 days after quarter end. Minimum payout is ₹1,000; smaller balances roll over. Payment is by bank transfer to the author’s linked account.',
  isbn: 'BookLeaf assigns each published book a unique ISBN under BookLeaf’s imprint. ISBN errors such as duplicate or mismatched records are high priority and escalated to production with a 48-hour resolution target.',
  printing: 'Print turnaround is 5–7 business days after order confirmation. After photos verify a printing defect, BookLeaf arranges a free reprint.',
  distribution: 'New listings usually go live within 7–10 business days after publication. Availability issues are often stock sync problems; the team can trigger a re-sync, usually within 24–48 hours.',
  production: 'Production stages: Manuscript Received, Editing, Cover Design, Typesetting, Proofreading, ISBN Assignment, Printing, Distribution Setup, Published & Live. Delays often involve cover approval or proofreading revisions.',
  general: 'Metadata updates can be requested through the author dashboard or by emailing BookLeaf. Platform changes usually appear within 3–5 business days.',
};

function classifyLocally(text) {
  const query = text.toLowerCase();
  let category = 'General Inquiry';
  if (/royalt|payment|payout|earning|paid|bank|sold copies|net profit/.test(query)) category = 'Royalty & Payments';
  else if (/isbn|metadata|description|author bio|book details/.test(query)) category = 'ISBN & Metadata Issues';
  else if (/print|quality|misprint|binding|blurry|pages|reprint|copies/.test(query)) category = 'Printing & Quality';
  else if (/amazon|flipkart|distribution|available|availability|listing|stock|store/.test(query)) category = 'Distribution & Availability';
  else if (/status|production|typeset|proof|cover|publish|delay|timeline/.test(query)) category = 'Book Status & Production Updates';

  let priority = 'Low';
  if (/fraud|legal|unsafe|critical|security breach|immediate danger/.test(query)) priority = 'Critical';
  else if (category === 'ISBN & Metadata Issues' || category === 'Printing & Quality' || /urgent|six months|6 months|overdue|duplicate isbn|wrong isbn|incorrect isbn|not received|missing|defect|broken|serious|no royalty/.test(query)) priority = 'High';
  else if (category === 'Royalty & Payments' || category === 'Book Status & Production Updates') priority = 'Medium';
  return { category, priority };
}

async function askModel(messages, maxTokens = 180) {
  if (!process.env.OPENAI_API_KEY) return null;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    const error = new Error(`AI provider returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || null;
}

export async function classifyTicket(subject, description) {
  const local = classifyLocally(`${subject}\n${description}`);
  try {
    const content = await askModel([
      { role: 'system', content: `Classify the support ticket. Return JSON only with category and priority. category must be one of ${categories.join('; ')}. priority must be one of ${priorities.join('; ')}. Set High for ISBN mismatches, defective printing or overdue payments; Critical only for severe urgent harm, legal or security issues. Otherwise use judgment.` },
      { role: 'user', content: `Subject: ${subject}\nQuery: ${description}` },
    ]);
    if (!content) return { ...local, source: 'rules' };
    const result = JSON.parse(content);
    return {
      category: categories.includes(result.category) ? result.category : local.category,
      priority: priorities.includes(result.priority) ? result.priority : local.priority,
      source: 'ai',
    };
  } catch (error) {
    console.warn(`Ticket classification used local fallback: ${error.message}`);
    return { ...local, source: 'rules' };
  }
}

function draftLocally(ticket, author, book) {
  const category = ticket.category;
  const opening = `Hi ${author.name.split(' ')[0]},\n\nThank you for reaching out, and I’m sorry this has caused concern. `;
  const closing = '\n\nPlease reply here with any details that can help us investigate. We’ll keep you updated on the next steps.\n\nWarmly,\nBookLeaf Author Support';
  let details = 'We’ve noted your query and our team will review it. We’ll follow up with a specific update as soon as we have more information.';
  if (category === 'Royalty & Payments') {
    details = `Royalties are calculated quarterly and paid within 45 days of the quarter ending, subject to the ₹1,000 minimum payout threshold. Balances below that threshold roll over. Please check that your bank details are linked in your dashboard. We can review the payout status and share a line-by-line breakdown${book ? ` for “${book.title}”` : ''}.`;
  } else if (category === 'ISBN & Metadata Issues') {
    details = 'We’re treating this as a priority and escalating it to our production team. We’ll investigate the book metadata and share an update within 48 hours.';
  } else if (category === 'Printing & Quality') {
    details = 'Please share clear photos of the affected copies so our team can verify the issue. Once confirmed, we’ll arrange a free reprint, which typically takes 5–7 business days after order confirmation.';
  } else if (category === 'Distribution & Availability') {
    details = 'This can happen when a retailer’s stock information has not synced. We’ll ask our distribution team to trigger a re-sync; availability typically updates within 24–48 hours.';
  } else if (category === 'Book Status & Production Updates') {
    details = `We’ll check the current production stage${book ? ` for “${book.title}”` : ''} and confirm a realistic next-step timeline. If anything is waiting on review or approval, we’ll explain that clearly and work through it together.`;
  } else {
    details = 'We’ll review your request and confirm the right next step. For book description or other metadata updates, you can also submit the change through your dashboard; updates on retail platforms usually take 3–5 business days.';
  }
  return opening + details + closing;
}

export async function draftResponse(ticket, author, book) {
  const fallback = draftLocally(ticket, author, book);
  try {
    const categoryKey = ticket.category.startsWith('Royalty') ? 'royalty'
      : ticket.category.startsWith('ISBN') ? 'isbn'
        : ticket.category.startsWith('Printing') ? 'printing'
          : ticket.category.startsWith('Distribution') ? 'distribution'
            : ticket.category.startsWith('Book Status') ? 'production' : 'general';
    const content = await askModel([
      {
        role: 'system',
        content: `You are a BookLeaf Publishing author support representative. Return valid JSON only in the shape {"response":"..."} where response is concise, empathetic, professional plain text. Acknowledge the concern, never invent account facts, dates, investigations, or actions already taken, and end with a clear next step. If information is missing, say what the team will verify. Use the relevant policy accurately: ${knowledge[categoryKey]}`,
      },
      {
        role: 'user',
        content: `Author: ${author.name}\nCategory: ${ticket.category}\nPriority: ${ticket.priority}\nBook: ${book?.title || 'General / Account Level'}\nSubject: ${ticket.subject}\nQuery: ${ticket.description}`,
      },
    ], 300);
    if (!content) return { text: fallback, source: 'rules' };
    const result = JSON.parse(content);
    if (typeof result.response !== 'string' || result.response.trim().length < 25) {
      return { text: fallback, source: 'rules' };
    }
    return { text: result.response.trim(), source: 'ai' };
  } catch (error) {
    console.warn(`Response draft used local fallback: ${error.message}`);
    return { text: fallback, source: 'rules' };
  }
}
