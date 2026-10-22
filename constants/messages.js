const MESSAGES = {
  ai: {
    handoffDefault: 'Mình chưa có đủ thông tin để trả lời chính xác câu hỏi này. Mình đã chuyển nội dung cho nhân viên hỗ trợ, bạn vui lòng chờ trong giây lát nhé.',
    start: 'Xin chào! Mình có thể trả lời câu hỏi đơn giản, tra thời tiết, xem một số thông tin hiện hành, đọc tài liệu PDF/DOCX/text bạn gửi, hoặc chuyển cho nhân viên hỗ trợ khi cần.',
    help: [
      'Bạn có thể nhắn câu hỏi trực tiếp, ví dụ:',
      '- Thời tiết Hà Nội hôm nay thế nào?',
      '- Tổng thống hiện tại của Mỹ là ai?',
      '- Tóm tắt file tôi vừa gửi',
      '- Cho tôi gặp nhân viên hỗ trợ',
      'Bot hiện đọc được tin nhắn văn bản và tài liệu PDF/DOCX/text.',
    ].join('\n'),
  },
  telegram: {
    documentUploaded: (filename, chunks) =>
      `Đã upload tài liệu "${filename}" (${chunks} đoạn). Bạn có thể hỏi mình theo tài liệu này.`,
    documentUploadFailed: (errorMessage) => `Chưa upload được tài liệu: ${errorMessage}`,
    unsupportedMessage: 'Mình đã nhận được nội dung bạn gửi, nhưng hiện tại bot chỉ đọc được tin nhắn văn bản và tài liệu PDF/DOCX/text. Nhân viên hỗ trợ có thể xem thông báo này trong hệ thống.',
    uploadedDocumentStatus: (filename, mimeType, size, chunks, errorMessage) =>
      `📎 Telegram uploaded document: ${filename} (${mimeType}, ${size}). Indexed for AI with ${chunks} chunk(s), but Rocket.Chat file upload failed: ${errorMessage}`,
  },
  liveLookup: {
    weatherLocationPrompt: 'Bạn muốn xem thời tiết ở khu vực nào? Ví dụ: "Thời tiết Hà Nội hôm nay thế nào?"',
    weatherLocationNotFound: (location) => `Mình chưa tìm được địa điểm "${location}". Bạn gửi rõ hơn tên thành phố/tỉnh giúp mình nhé.`,
    weather: (placeName, weatherText, temperature, humidity, windSpeed, time) => [
      `Thời tiết hiện tại ở ${placeName}: ${weatherText}, ${temperature}°C.`,
      `Độ ẩm ${humidity}%, gió ${windSpeed} km/h.`,
      `Cập nhật lúc ${time}. Nguồn: Open-Meteo.`,
    ],
    officeTypePrompt: 'Bạn muốn hỏi chức danh hiện tại của quốc gia nào?',
    wikipediaSource: (title, incumbent, incumbentSince, source) =>
      `${title}: ${incumbent}${incumbentSince ? `, giữ chức từ ${incumbentSince}` : ''}. Nguồn: Wikipedia (${source}).`,
  },
  routing: {
    failed: 'Mình đã nhận được tin nhắn của bạn, nhưng hiện chưa kết nối được hệ thống hỗ trợ. Bạn vui lòng thử lại sau ít phút nhé.',
  },
};

const WEATHER_CODES = new Map([
  [0, 'trời quang'],
  [1, 'ít mây'],
  [2, 'mây rải rác'],
  [3, 'nhiều mây'],
  [45, 'sương mù'],
  [48, 'sương mù đóng băng'],
  [51, 'mưa phùn nhẹ'],
  [53, 'mưa phùn vừa'],
  [55, 'mưa phùn dày'],
  [61, 'mưa nhẹ'],
  [63, 'mưa vừa'],
  [65, 'mưa to'],
  [71, 'tuyết nhẹ'],
  [73, 'tuyết vừa'],
  [75, 'tuyết dày'],
  [80, 'mưa rào nhẹ'],
  [81, 'mưa rào vừa'],
  [82, 'mưa rào mạnh'],
  [95, 'dông'],
  [96, 'dông kèm mưa đá nhẹ'],
  [99, 'dông kèm mưa đá mạnh'],
]);

module.exports = { MESSAGES, WEATHER_CODES };
