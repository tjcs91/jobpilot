const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PUBLIC_DIR = process.env.PUBLIC_DIR || __dirname;

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || '');

function now() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value || '').trim();
}

function safeEmail(value) {
  return clean(value).toLowerCase();
}

function parseCookies(req) {
  const out = {};

  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;

    out[part.slice(0, i).trim()] =
      decodeURIComponent(part.slice(i + 1).trim());
  }

  return out;
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });

  res.end(body);
}

function html(res, file) {
  const target = path.resolve(PUBLIC_DIR, file);
  const root = path.resolve(PUBLIC_DIR);

  if (
    !(target === root || target.startsWith(root + path.sep)) ||
    !fs.existsSync(target)
  ) {
    return json(res, 404, { error: 'Not found' });
  }

  const content = fs.readFileSync(target);

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': content.length
  });

  res.end(content);
}

async function body(req) {
  return await new Promise((resolve, reject) => {
    let data = '';

    req.on('data', chunk => {
      data += chunk;

      if (data.length > 1e6) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });

    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

async function supabase(pathname, {
  method = 'GET',
  token = '',
  payload,
  headers = {}
} = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    const error = new Error('Supabase is not configured');
    error.status = 503;
    throw error;
  }

  const requestHeaders = {
    apikey: SUPABASE_KEY,
    Accept: 'application/json',
    ...headers
  };

  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  if (payload !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${SUPABASE_URL}${pathname}`, {
    method,
    headers: requestHeaders,
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      data?.msg ||
      data?.message ||
      data?.error_description ||
      data?.error ||
      `Supabase request failed (${response.status})`;

    const error = new Error(message);
    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

function isSecureCookie() {
  return BASE_URL.startsWith('https://') || Boolean(process.env.RENDER);
}

function setSessionCookies(res, session) {
  const secure = isSecureCookie() ? '; Secure' : '';
  const accessMaxAge = Math.max(60, Number(session.expires_in) || 3600);

  res.setHeader('Set-Cookie', [
    `jobpilot_access=${encodeURIComponent(session.access_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${accessMaxAge}${secure}`,
    `jobpilot_refresh=${encodeURIComponent(session.refresh_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`
  ]);
}

function clearSessionCookies(res) {
  const secure = isSecureCookie() ? '; Secure' : '';

  res.setHeader('Set-Cookie', [
    `jobpilot_access=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
    `jobpilot_refresh=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  ]);
}

function slugify(name) {
  return clean(name || 'business')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'business';
}

function businessToClient(business) {
  return {
    id: business.id,
    name: business.name,
    ownerName: business.owner_name || '',
    email: business.email || '',
    phone: business.phone || '',
    slug: business.slug,
    plan: business.plan || 'trial',
    timezone: business.timezone || 'Europe/London'
  };
}

function serviceToClient(service) {
  return {
    id: service.id,
    businessId: service.business_id,
    name: service.name,
    durationMin: Number(service.duration_minutes),
    pricePence: Number(service.price_pence),
    active: Boolean(service.active)
  };
}

function customerToClient(customer, bookingsCount = 0) {
  return {
    id: customer.id,
    businessId: customer.business_id,
    name: customer.name,
    phone: customer.phone || '',
    email: customer.email || '',
    vehicleDetails: customer.vehicle_details || '',
    notes: customer.notes || '',
    createdAt: customer.created_at,
    bookingsCount
  };
}

function statusToDatabase(status) {
  return {
    Booked: 'confirmed',
    Completed: 'completed',
    Cancelled: 'cancelled',
    'No-show': 'no_show'
  }[status] || null;
}

function statusToClient(status) {
  return {
    pending: 'Booked',
    confirmed: 'Booked',
    completed: 'Completed',
    cancelled: 'Cancelled',
    no_show: 'No-show'
  }[status] || 'Booked';
}

function getTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function localDateTimeToISO(date, time, timeZone = 'Europe/London') {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ||
    !/^\d{2}:\d{2}$/.test(String(time))
  ) {
    const error = new Error('Invalid booking date/time.');
    error.status = 400;
    throw error;
  }

  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);

  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);

  let guess = wanted;

  for (let i = 0; i < 3; i++) {
    const parts = getTimeParts(new Date(guess), timeZone);

    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0
    );

    guess += wanted - represented;
  }

  return new Date(guess).toISOString();
}

function dateTimeForClient(iso, timeZone = 'Europe/London') {
  const parts = getTimeParts(new Date(iso), timeZone);
  const pad = value => String(value).padStart(2, '0');

  return {
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`
  };
}

async function getBusinessForUser(userId, token) {
  const data = await supabase(
    `/rest/v1/businesses?owner_user_id=eq.${encodeURIComponent(userId)}&select=*`,
    { token }
  );

  return Array.isArray(data) ? data[0] || null : null;
}

async function ensureBusiness(user, token) {
  let business = await getBusinessForUser(user.id, token);

  if (business) {
    return business;
  }

  const metadata = user.user_metadata || {};
  const businessName = clean(metadata.business_name || 'My Business');
  const ownerName = clean(metadata.owner_name || '');
  const phone = clean(metadata.phone || '');
  const baseSlug = slugify(businessName);

  function makeBusinessPayload(slug) {
    return {
      owner_user_id: user.id,
      name: businessName,
      owner_name: ownerName,
      email: safeEmail(user.email),
      phone,
      slug,
      plan: 'trial'
    };
  }

  let created;

  try {
    created = await supabase('/rest/v1/businesses', {
      method: 'POST',
      token,
      payload: makeBusinessPayload(baseSlug),
      headers: {
        Prefer: 'return=representation'
      }
    });
  } catch (error) {
    if (error.status !== 409) {
      throw error;
    }

    const suffix = String(user.id).replace(/-/g, '').slice(0, 6);

    created = await supabase('/rest/v1/businesses', {
      method: 'POST',
      token,
      payload: makeBusinessPayload(`${baseSlug}-${suffix}`),
      headers: {
        Prefer: 'return=representation'
      }
    });
  }

  business = created?.[0];

  if (!business) {
    throw new Error('Could not create business profile');
  }

  const defaultServices = [
    {
      business_id: business.id,
      name: 'Full Valet',
      duration_minutes: 120,
      price_pence: 8000,
      active: true,
      sort_order: 1
    },
    {
      business_id: business.id,
      name: 'Mini Valet',
      duration_minutes: 60,
      price_pence: 4500,
      active: true,
      sort_order: 2
    },
    {
      business_id: business.id,
      name: 'Exterior Detail',
      duration_minutes: 90,
      price_pence: 6000,
      active: true,
      sort_order: 3
    }
  ];

  await supabase('/rest/v1/services', {
    method: 'POST',
    token,
    payload: defaultServices,
    headers: {
      Prefer: 'return=minimal'
    }
  });

  return business;
}

async function authenticate(req, res) {
  const cookieValues = parseCookies(req);

  let accessToken = cookieValues.jobpilot_access || '';
  const refreshToken = cookieValues.jobpilot_refresh || '';

  let user = null;

  if (accessToken) {
    try {
      user = await supabase('/auth/v1/user', { token: accessToken });
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) {
        throw error;
      }
    }
  }

  if (!user && refreshToken) {
    try {
      const session = await supabase(
        '/auth/v1/token?grant_type=refresh_token',
        {
          method: 'POST',
          payload: {
            refresh_token: refreshToken
          }
        }
      );

      accessToken = session.access_token;
      user = session.user;

      setSessionCookies(res, session);
    } catch {
      clearSessionCookies(res);
      return null;
    }
  }

  if (!user) {
    return null;
  }

  const business = await ensureBusiness(user, accessToken);

  return {
    user,
    business,
    token: accessToken
  };
}

async function handle(req, res) {
  const requestUrl = new URL(req.url, BASE_URL);
  const pathname = requestUrl.pathname;
  const method = req.method;

  if (method === 'GET' && pathname === '/health') {
    return json(res, 200, {
      ok: true,
      time: now(),
      database: 'supabase',
      configured: Boolean(SUPABASE_URL && SUPABASE_KEY)
    });
  }

  if (method === 'GET' && pathname === '/') {
    return html(res, 'landing.html');
  }

  if (method === 'GET' && pathname === '/app') {
    return html(res, 'app.html');
  }

  if (method === 'GET' && pathname.startsWith('/book/')) {
    return html(res, 'book.html');
  }

  if (method === 'GET' && pathname === '/prototype') {
    return html(res, 'prototype.html');
  }

  try {
    if (method === 'POST' && pathname === '/api/auth/signup') {
      const data = await body(req);
      const userEmail = safeEmail(data.email);

      if (
        !data.businessName ||
        !userEmail ||
        !data.password ||
        String(data.password).length < 8
      ) {
        return json(res, 400, {
          error: 'Business name, email and an 8+ character password are required.'
        });
      }

      const session = await supabase('/auth/v1/signup', {
        method: 'POST',
        payload: {
          email: userEmail,
          password: String(data.password),
          data: {
            business_name: clean(data.businessName),
            owner_name: clean(data.ownerName),
            phone: clean(data.phone)
          }
        }
      });

      if (!session?.access_token || !session?.refresh_token) {
        return json(res, 200, {
          ok: true,
          needsEmailConfirmation: true,
          message: 'Account created. Check your email to confirm your account, then sign in.'
        });
      }

      setSessionCookies(res, session);

      const business = await ensureBusiness(
        session.user,
        session.access_token
      );

      return json(res, 200, {
        ok: true,
        slug: business.slug
      });
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const data = await body(req);
      const userEmail = safeEmail(data.email);

      if (!userEmail || !data.password) {
        return json(res, 400, {
          error: 'Email and password are required.'
        });
      }

      let session;

      try {
        session = await supabase(
          '/auth/v1/token?grant_type=password',
          {
            method: 'POST',
            payload: {
              email: userEmail,
              password: String(data.password)
            }
          }
        );
      } catch (error) {
        if (error.status === 400 || error.status === 401) {
          return json(res, 401, {
            error: 'Invalid email or password.'
          });
        }

        throw error;
      }

      setSessionCookies(res, session);

      await ensureBusiness(
        session.user,
        session.access_token
      );

      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      const cookieValues = parseCookies(req);

      if (cookieValues.jobpilot_access) {
        try {
          await supabase('/auth/v1/logout', {
            method: 'POST',
            token: cookieValues.jobpilot_access
          });
        } catch {
          // Ignore logout API errors.
        }
      }

      clearSessionCookies(res);

      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname.startsWith('/api/public/')) {
      const slug = decodeURIComponent(pathname.split('/')[3] || '');

      const publicBusiness = await supabase(
        '/rest/v1/rpc/get_public_business',
        {
          method: 'POST',
          payload: {
            business_slug: slug
          }
        }
      );

      if (!publicBusiness || !publicBusiness.id) {
        return json(res, 404, {
          error: 'Business not found'
        });
      }

      return json(res, 200, {
        business: {
          name: publicBusiness.name,
          ownerName: publicBusiness.owner_name || '',
          phone: publicBusiness.phone || '',
          slug: publicBusiness.slug
        },
        services: (publicBusiness.services || []).map(service => ({
          id: service.id,
          name: service.name,
          durationMin: Number(service.duration_minutes),
          pricePence: Number(service.price_pence)
        }))
      });
    }

    if (
      method === 'POST' &&
      pathname.startsWith('/api/public/') &&
      pathname.endsWith('/book')
    ) {
      const slug = decodeURIComponent(pathname.split('/')[3] || '');
      const data = await body(req);

      if (
        !data.serviceId ||
        !data.name ||
        (!data.email && !data.phone) ||
        !data.date ||
        !data.time
      ) {
        return json(res, 400, {
          error: 'Service, name, contact details, date and time are required.'
        });
      }

      const publicBusiness = await supabase(
        '/rest/v1/rpc/get_public_business',
        {
          method: 'POST',
          payload: {
            business_slug: slug
          }
        }
      );

      if (!publicBusiness || !publicBusiness.id) {
        return json(res, 404, {
          error: 'Business not found'
        });
      }

      const startAt = localDateTimeToISO(
        data.date,
        data.time,
        publicBusiness.timezone || 'Europe/London'
      );

      try {
        const result = await supabase(
          '/rest/v1/rpc/create_public_booking',
          {
            method: 'POST',
            payload: {
              business_slug: slug,
              requested_service_id: data.serviceId,
              customer_name: clean(data.name),
              customer_email: safeEmail(data.email),
              customer_phone: clean(data.phone),
              requested_start_at: startAt,
              customer_notes: clean(data.notes),
              customer_vehicle_details: clean(data.vehicleDetails),
              booking_address: clean(data.address)
            }
          }
        );

        return json(res, 200, {
          ok: true,
          booking: result || null
        });
      } catch (error) {
        const message = String(error.message || '');

        if (message.toLowerCase().includes('overlap')) {
          return json(res, 409, {
            error: 'That time is no longer available. Please choose another slot.'
          });
        }

        throw error;
      }
    }

    const auth = await authenticate(req, res);

    if (!auth) {
      return json(res, 401, {
        error: 'Please sign in.'
      });
    }

    if (method === 'GET' && pathname === '/api/me') {
      return json(res, 200, {
        user: {
          id: auth.user.id,
          email: auth.user.email
        },
        business: businessToClient(auth.business)
      });
    }

    if (method === 'GET' && pathname === '/api/settings') {
      const settingsRows = await supabase(
        `/rest/v1/business_settings?business_id=eq.${encodeURIComponent(auth.business.id)}&select=*`,
        { token: auth.token }
      );

      const settings = Array.isArray(settingsRows)
        ? settingsRows[0] || {}
        : {};

      return json(res, 200, {
        businessName: auth.business.name,
        ownerName: auth.business.owner_name || '',
        email: auth.business.email || '',
        phone: auth.business.phone || '',
        slug: auth.business.slug,
        intro: settings.intro || '',
        bookingEnabled: Boolean(settings.booking_enabled),
        minimumNoticeHours: Number(settings.minimum_notice_hours ?? 2),
        bookingWindowDays: Number(settings.booking_window_days ?? 60),
        mondayEnabled: Boolean(settings.monday_enabled),
        tuesdayEnabled: Boolean(settings.tuesday_enabled),
        wednesdayEnabled: Boolean(settings.wednesday_enabled),
        thursdayEnabled: Boolean(settings.thursday_enabled),
        fridayEnabled: Boolean(settings.friday_enabled),
        saturdayEnabled: Boolean(settings.saturday_enabled),
        sundayEnabled: Boolean(settings.sunday_enabled),
        workdayStart: String(settings.workday_start || '09:00').slice(0, 5),
        workdayEnd: String(settings.workday_end || '17:00').slice(0, 5),
        bufferMinutes: Number(settings.buffer_minutes ?? 0)
      });
    }

    if (method === 'PATCH' && pathname === '/api/settings') {
      const data = await body(req);

      const businessPatch = {};

      if (data.businessName !== undefined) {
        businessPatch.name = clean(data.businessName);
      }

      if (data.ownerName !== undefined) {
        businessPatch.owner_name = clean(data.ownerName);
      }

      if (data.email !== undefined) {
        businessPatch.email = safeEmail(data.email);
      }

      if (data.phone !== undefined) {
        businessPatch.phone = clean(data.phone);
      }

      if (data.slug !== undefined) {
        businessPatch.slug = slugify(data.slug);
      }

      if (Object.keys(businessPatch).length) {
        await supabase(
          `/rest/v1/businesses?id=eq.${encodeURIComponent(auth.business.id)}`,
          {
            method: 'PATCH',
            token: auth.token,
            payload: businessPatch,
            headers: {
              Prefer: 'return=minimal'
            }
          }
        );
      }

      const settingsPatch = {};

      const settingsMap = {
        intro: 'intro',
        bookingEnabled: 'booking_enabled',
        minimumNoticeHours: 'minimum_notice_hours',
        bookingWindowDays: 'booking_window_days',
        mondayEnabled: 'monday_enabled',
        tuesdayEnabled: 'tuesday_enabled',
        wednesdayEnabled: 'wednesday_enabled',
        thursdayEnabled: 'thursday_enabled',
        fridayEnabled: 'friday_enabled',
        saturdayEnabled: 'saturday_enabled',
        sundayEnabled: 'sunday_enabled',
        workdayStart: 'workday_start',
        workdayEnd: 'workday_end',
        bufferMinutes: 'buffer_minutes'
      };

      for (const [clientKey, dbKey] of Object.entries(settingsMap)) {
        if (data[clientKey] !== undefined) {
          settingsPatch[dbKey] = data[clientKey];
        }
      }

      if (Object.keys(settingsPatch).length) {
        await supabase(
          `/rest/v1/business_settings?business_id=eq.${encodeURIComponent(auth.business.id)}`,
          {
            method: 'PATCH',
            token: auth.token,
            payload: settingsPatch,
            headers: {
              Prefer: 'return=minimal'
            }
          }
        );
      }

      return json(res, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/services') {
      const services = await supabase(
        `/rest/v1/services?business_id=eq.${encodeURIComponent(auth.business.id)}&select=*&order=sort_order.asc,name.asc`,
        { token: auth.token }
      );

      return json(res, 200, (services || []).map(serviceToClient));
    }

    if (method === 'POST' && pathname === '/api/services') {
      const data = await body(req);

      const durationMin = Number(data.durationMin);
      const pricePence = Math.round(Number(data.price) * 100);

      if (
        !clean(data.name) ||
        durationMin < 15 ||
        !Number.isFinite(pricePence) ||
        pricePence < 0
      ) {
        return json(res, 400, {
          error: 'Invalid service.'
        });
      }

      const created = await supabase('/rest/v1/services', {
        method: 'POST',
        token: auth.token,
        payload: {
          business_id: auth.business.id,
          name: clean(data.name),
          duration_minutes: durationMin,
          price_pence: pricePence,
          active: true
        },
        headers: {
          Prefer: 'return=representation'
        }
      });

      return json(res, 201, serviceToClient(created[0]));
    }

    if (method === 'GET' && pathname === '/api/customers') {
      const [customers, bookings] = await Promise.all([
        supabase(
          `/rest/v1/customers?business_id=eq.${encodeURIComponent(auth.business.id)}&select=*&order=created_at.desc`,
          { token: auth.token }
        ),
        supabase(
          `/rest/v1/bookings?business_id=eq.${encodeURIComponent(auth.business.id)}&select=customer_id`,
          { token: auth.token }
        )
      ]);

      const bookingCounts = {};

      for (const booking of bookings || []) {
        if (booking.customer_id) {
          bookingCounts[booking.customer_id] =
            (bookingCounts[booking.customer_id] || 0) + 1;
        }
      }

      return json(
        res,
        200,
        (customers || []).map(customer =>
          customerToClient(
            customer,
            bookingCounts[customer.id] || 0
          )
        )
      );
    }

    if (method === 'POST' && pathname === '/api/customers') {
      const data = await body(req);

      if (!clean(data.name)) {
        return json(res, 400, {
          error: 'Customer name is required.'
        });
      }

      const created = await supabase('/rest/v1/customers', {
        method: 'POST',
        token: auth.token,
        payload: {
          business_id: auth.business.id,
          name: clean(data.name),
          phone: clean(data.phone),
          email: safeEmail(data.email) || null,
          vehicle_details: clean(data.vehicleDetails),
          notes: clean(data.notes)
        },
        headers: {
          Prefer: 'return=representation'
        }
      });

      return json(res, 201, customerToClient(created[0]));
    }

    if (method === 'GET' && pathname === '/api/bookings') {
      const bookings = await supabase(
        `/rest/v1/bookings?business_id=eq.${encodeURIComponent(auth.business.id)}&select=*&order=start_at.asc`,
        { token: auth.token }
      );

      const customerIds = [
        ...new Set(
          (bookings || [])
            .map(booking => booking.customer_id)
            .filter(Boolean)
        )
      ];

      let customers = [];

      if (customerIds.length) {
        customers = await supabase(
          `/rest/v1/customers?business_id=eq.${encodeURIComponent(auth.business.id)}&select=*`,
          { token: auth.token }
        );
      }

      const customersById = Object.fromEntries(
        customers.map(customer => [customer.id, customer])
      );

      const result = (bookings || []).map(booking => {
        const customer = customersById[booking.customer_id] || {};

        const local = dateTimeForClient(
          booking.start_at,
          auth.business.timezone || 'Europe/London'
        );

        return {
          id: booking.id,
          businessId: booking.business_id,
          customerId: booking.customer_id,
          serviceId: booking.service_id,
          customerName: customer.name || '',
          phone: customer.phone || '',
          email: customer.email || '',
          vehicleDetails: customer.vehicle_details || '',
          serviceName: booking.service_name,
          pricePence: Number(booking.price_pence),
          durationMin: Number(booking.duration_minutes),
          date: local.date,
          time: local.time,
          address: booking.address || '',
          notes: booking.notes || '',
          status: statusToClient(booking.status),
          createdAt: booking.created_at
        };
      });

      return json(res, 200, result);
    }

    if (method === 'POST' && pathname === '/api/bookings') {
      const data = await body(req);

      if (
        !data.customerId ||
        !data.serviceId ||
        !data.date ||
        !data.time
      ) {
        return json(res, 400, {
          error: 'Customer, service, date and time are required.'
        });
      }

      const services = await supabase(
        `/rest/v1/services?id=eq.${encodeURIComponent(data.serviceId)}&business_id=eq.${encodeURIComponent(auth.business.id)}&select=*`,
        { token: auth.token }
      );

      const service = services?.[0];

      if (!service) {
        return json(res, 404, {
          error: 'Service not found.'
        });
      }

      const customers = await supabase(
        `/rest/v1/customers?id=eq.${encodeURIComponent(data.customerId)}&business_id=eq.${encodeURIComponent(auth.business.id)}&select=*`,
        { token: auth.token }
      );

      const customer = customers?.[0];

      if (!customer) {
        return json(res, 404, {
          error: 'Customer not found.'
        });
      }

      const startAt = localDateTimeToISO(
        data.date,
        data.time,
        auth.business.timezone || 'Europe/London'
      );

      const endAt = new Date(
        new Date(startAt).getTime() +
        Number(service.duration_minutes) * 60000
      ).toISOString();

      let created;

      try {
        created = await supabase('/rest/v1/bookings', {
          method: 'POST',
          token: auth.token,
          payload: {
            business_id: auth.business.id,
            customer_id: customer.id,
            service_id: service.id,
            service_name: service.name,
            price_pence: service.price_pence,
            duration_minutes: service.duration_minutes,
            start_at: startAt,
            end_at: endAt,
            status: 'confirmed',
            address: clean(data.address),
            notes: clean(data.notes),
            source: 'dashboard'
          },
          headers: {
            Prefer: 'return=representation'
          }
        });
      } catch (error) {
        if (
          error.status === 409 ||
          String(error.message).toLowerCase().includes('overlap')
        ) {
          return json(res, 409, {
            error: 'That booking overlaps an existing booking.'
          });
        }

        throw error;
      }

      return json(res, 201, {
        ok: true,
        id: created?.[0]?.id
      });
    }

    if (method === 'PATCH' && pathname.startsWith('/api/bookings/')) {
      const bookingId = decodeURIComponent(pathname.split('/')[3] || '');
      const data = await body(req);

      const patch = {};

      if (data.status !== undefined) {
        const dbStatus = statusToDatabase(data.status);

        if (!dbStatus) {
          return json(res, 400, {
            error: 'Invalid booking status.'
          });
        }

        patch.status = dbStatus;
      }

      if (data.notes !== undefined) {
        patch.notes = clean(data.notes);
      }

      if (data.address !== undefined) {
        patch.address = clean(data.address);
      }

      if (data.date !== undefined || data.time !== undefined) {
        const existing = await supabase(
          `/rest/v1/bookings?id=eq.${encodeURIComponent(bookingId)}&business_id=eq.${encodeURIComponent(auth.business.id)}&select=*`,
          { token: auth.token }
        );

        const booking = existing?.[0];

        if (!booking) {
          return json(res, 404, {
            error: 'Booking not found.'
          });
        }

        const currentLocal = dateTimeForClient(
          booking.start_at,
          auth.business.timezone || 'Europe/London'
        );

        const newDate = data.date || currentLocal.date;
        const newTime = data.time || currentLocal.time;

        const newStart = localDateTimeToISO(
          newDate,
          newTime,
          auth.business.timezone || 'Europe/London'
        );

        const newEnd = new Date(
          new Date(newStart).getTime() +
          Number(booking.duration_minutes) * 60000
        ).toISOString();

        patch.start_at = newStart;
        patch.end_at = newEnd;
      }

      if (!Object.keys(patch).length) {
        return json(res, 400, {
          error: 'Nothing to update.'
        });
      }

      try {
        const updated = await supabase(
          `/rest/v1/bookings?id=eq.${encodeURIComponent(bookingId)}&business_id=eq.${encodeURIComponent(auth.business.id)}`,
          {
            method: 'PATCH',
            token: auth.token,
            payload: patch,
            headers: {
              Prefer: 'return=representation'
            }
          }
        );

        if (!updated || !updated.length) {
          return json(res, 404, {
            error: 'Booking not found.'
          });
        }

        return json(res, 200, {
          ok: true
        });
      } catch (error) {
        if (
          error.status === 409 ||
          String(error.message).toLowerCase().includes('overlap')
        ) {
          return json(res, 409, {
            error: 'That booking overlaps an existing booking.'
          });
        }

        throw error;
      }
    }

    if (method === 'POST' && pathname === '/api/quotes/draft') {
      const data = await body(req);

      const services = await supabase(
        `/rest/v1/services?business_id=eq.${encodeURIComponent(auth.business.id)}&active=eq.true&select=*&order=sort_order.asc,name.asc`,
        { token: auth.token }
      );

      const enquiry = clean(data.enquiry || data.message);

      const serviceList = (services || [])
        .map(
          service =>
            `${service.name}: £${(
              Number(service.price_pence) / 100
            ).toFixed(2)}`
        )
        .join(', ');

      let draft =
        `Thanks for getting in touch with ${auth.business.name}. ` +
        (
          serviceList
            ? `Our current services include ${serviceList}. `
            : ''
        ) +
        'If you send over your preferred date, location and vehicle details, we can confirm availability.';

      if (process.env.OPENAI_API_KEY && enquiry) {
        try {
          const response = await fetch(
            'https://api.openai.com/v1/chat/completions',
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                messages: [
                  {
                    role: 'system',
                    content:
                      'Write a short, friendly UK-English reply for a mobile service business. Do not invent prices or availability.'
                  },
                  {
                    role: 'user',
                    content:
                      `Business: ${auth.business.name}\nServices: ${serviceList}\nCustomer enquiry: ${enquiry}`
                  }
                ],
                temperature: 0.4
              })
            }
          );

          if (response.ok) {
            const result = await response.json();
            const generated = result?.choices?.[0]?.message?.content;

            if (clean(generated)) {
              draft = clean(generated);
            }
          }
        } catch {
          // Keep fallback draft.
        }
      }

      return json(res, 200, { draft });
    }

    if (method === 'POST' && pathname === '/api/billing/checkout') {
      return json(res, 501, {
        error: 'Billing is not connected yet.'
      });
    }

    return json(res, 404, {
      error: 'API route not found.'
    });
  } catch (error) {
    console.error('JobPilot request error:', error);

    const status =
      Number(error.status) >= 400 &&
      Number(error.status) < 600
        ? Number(error.status)
        : 500;

    return json(res, status, {
      error:
        status === 500
          ? 'Something went wrong.'
          : String(error.message || 'Request failed.')
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    console.error('Unhandled JobPilot error:', error);

    if (!res.headersSent) {
      json(res, 500, {
        error: 'Internal server error.'
      });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`JobPilot running at http://localhost:${PORT}`);
  console.log(
    `Supabase configured: ${Boolean(SUPABASE_URL && SUPABASE_KEY)}`
  );
});
